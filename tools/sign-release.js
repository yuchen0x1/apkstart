'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assetNames, readManifest, repo } = require('../src/core/release-manifest');
const { sha256File } = require('../src/core/download');

async function run(command, dir, arg) {
  if (command === '--check-upload') {
    const assets = JSON.parse(fs.readFileSync(arg)).assets;
    const names = fs.readdirSync(dir);
    if (assets.length !== names.length) throw Error('Unexpected number of uploaded assets');
    for (const name of names) {
      const file = path.join(dir, name);
      const a = assets.find(entry => entry.name === name);
      if (!a || a.size !== fs.statSync(file).size || a.digest !== 'sha256:' + await sha256File(file)) throw Error('上传校验失败 ' + name);
    }
    return;
  }
  const tag = command;
  const names = Object.values(assetNames(tag));
  if (fs.readdirSync(dir).length !== names.length) throw Error('Unexpected release files');
  const assets = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const size = fs.statSync(file).size;
    if (!size) throw Error('Empty asset ' + name);
    assets.push({ name, size, sha256: await sha256File(file) });
  }
  const bytes = Buffer.from(JSON.stringify({ schema: 1, repository: repo, tag, assets }));
  const sig = crypto.sign(null, bytes, process.env.APKSTART_RELEASE_KEY);
  const comment = '<!-- apkstart-manifest ' + bytes.toString('base64') + ' ' + sig.toString('base64') + ' -->';
  readManifest(comment, tag);
  fs.appendFileSync(arg, '\n' + comment + '\n');
  fs.writeFileSync(path.join(dir, 'ApkStart-update.json'), bytes);
  fs.writeFileSync(path.join(dir, 'ApkStart-update.json.sig'), sig);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), assets.map(a => a.sha256 + '  ' + a.name).join('\n') + '\n');
}
run(...process.argv.slice(2)).catch(err => { console.error(err.message); process.exitCode = 1; });
