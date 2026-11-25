'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { applyLocale } = require('../src/core/guest');

test('applyLocale requires an exact locale in the system setting readback', async () => {
  const calls = [];
  const client = {
    shell: async (command) => {
      calls.push(command);
      return command === 'settings get system system_locales' ? 'en-US, zh-CN' : 'Success';
    },
  };

  const result = await applyLocale(client, 'zh-CN');
  assert.equal(result.ok, true);
  assert.equal(result.setting, 'en-US, zh-CN');
  assert.equal(calls.at(-1), 'settings get system system_locales');
});

test('applyLocale rejects a setting that only contains a partial locale match', async () => {
  const client = {
    shell: async (command) => command === 'settings get system system_locales' ? 'zh-CN-extra' : 'Success',
  };

  const result = await applyLocale(client, 'zh-CN');
  assert.equal(result.ok, false);
  assert.match(result.error, /语言写入失败/);
});
