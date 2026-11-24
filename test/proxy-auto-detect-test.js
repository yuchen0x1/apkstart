'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const proxy = require('../src/core/proxy');

test('NO_PROXY supports wildcard, exact host, suffix and optional port', () => {
  const previous = process.env.NO_PROXY;
  const previousLower = process.env.no_proxy;
  try {
    delete process.env.no_proxy;
    process.env.NO_PROXY = 'localhost,.example.test,api.internal.test:8443,[::1]:443';
    assert.equal(proxy.isNoProxy('localhost', 80), true);
    assert.equal(proxy.isNoProxy('api.example.test', 443), true);
    assert.equal(proxy.isNoProxy('example.test', 443), true);
    assert.equal(proxy.isNoProxy('api.internal.test', 8443), true);
    assert.equal(proxy.isNoProxy('api.internal.test', 443), false);
    assert.equal(proxy.isNoProxy('::1', 443), true);
    assert.equal(proxy.isNoProxy('notexample.test', 443), false);
    process.env.NO_PROXY = '*';
    assert.equal(proxy.isNoProxy('anything.invalid', 443), true);
  } finally {
    if (previous === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previous;
    if (previousLower === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = previousLower;
  }
});

test('HTTPS_PROXY is detected automatically and legacy proxyUrl is ignored', async () => {
  const upper = process.env.HTTPS_PROXY;
  const lower = process.env.https_proxy;
  try {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    proxy.resetCache();
    assert.deepEqual(await proxy.getActiveProxy({
      runtime: { proxyUrl: 'http://should-not-be-used.invalid:8888' },
    }, { force: true }), {
      host: '127.0.0.1',
      port: 7890,
      protocol: 'http',
    });
  } finally {
    if (upper === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = upper;
    if (lower === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = lower;
    proxy.resetCache();
  }
});

test('Windows and GNOME proxy readers fail closed to an empty result when unsupported', async () => {
  if (process.platform !== 'win32') assert.equal(await proxy.fromRegistry(), '');
  if (process.platform !== 'linux') assert.equal(await proxy.fromGnome(), '');
});
