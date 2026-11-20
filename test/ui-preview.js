'use strict';
/** 真实渲染层的本机预览：仅用内存夹具，不导入主进程、不连接 Android、不访问外网。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createFixture } = require('./lib/ui-fixtures');
const UI = path.join(__dirname, '..', 'src', 'ui');
const SITE = path.join(__dirname, '..', 'site');
const fixture = createFixture();
const preload = fs.readFileSync(path.join(UI, '..', 'preload.js'), 'utf8').replace(
  "const { contextBridge, ipcRenderer, webUtils } = require('electron');",
  `const contextBridge = { exposeInMainWorld: (key, value) => { window[key] = value; } };
const ipcRenderer = {
  invoke: (channel, payload) => fetch('/__fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, payload }) }).then(r => r.json()),
  on: () => {}, removeListener: () => {}, send: () => {}
};
const webUtils = { getPathForFile: () => '' };`,
);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__fixture' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) { res.writeHead(413).end(); return; }
      }
      const { channel, payload } = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(await fixture.respond(channel, payload) ?? null));
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (url.pathname === '/ui-fixture.js') {
      res.setHeader('Content-Type', mime['.js']);
      res.end(preload);
      return;
    }
    const base = url.pathname.startsWith('/website/') ? SITE : UI;
    const pathname = base === SITE ? url.pathname.slice('/website'.length) : url.pathname;
    const file = path.resolve(base, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    const rel = path.relative(base, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    let content = fs.readFileSync(file);
    if (path.extname(file) === '.html' && base === UI) content = content.toString('utf8').replace('<head>', '<head>\n<script src="/ui-fixture.js"></script>');
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.end(content);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(e.message);
  }
});
server.listen(0, '127.0.0.1', () => console.log(`UI_PREVIEW_URL=http://127.0.0.1:${server.address().port}`));
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
