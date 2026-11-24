'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('benchmark refuses to stop an attached runtime', () => {
  const script = path.join(__dirname, '..', 'tools', 'bench-runtime.js');
  const result = spawnSync(process.execPath, [script, '--attach', '--port', '5554', '--stop'], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--stop cannot be used with --attach/);
});
