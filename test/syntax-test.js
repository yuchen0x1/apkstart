'use strict';
// Parse owned JavaScript without loading the product or running its side effects.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let checked = 0;
function checkTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) checkTree(file);
    else if (entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name)) {
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 15000 });
      assert.equal(r.status, 0, `${path.relative(ROOT, file)}\n${r.error || r.stderr}`);
      checked++;
    }
  }
}
for (const dir of ['src', 'test', 'build', 'tools', 'scripts']) checkTree(path.join(ROOT, dir));
console.log(`Syntax OK: ${checked} JavaScript files (no product code executed)`);
