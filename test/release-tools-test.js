'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isExpectedAssetUrl } = require('../tools/sign-release');
const { repo } = require('../src/core/release-manifest');

test('release asset URLs accept final tag paths and only GitHub draft asset paths', () => {
  const tag = 'v0.11.2';
  const name = 'ApkStart-0.11.2-Setup.exe';
  assert.equal(isExpectedAssetUrl(`${repo}/releases/download/${tag}/${name}`, tag, name, false), true);
  assert.equal(isExpectedAssetUrl(
    `https://github.com/yuchen0x1/apkstart/releases/download/untagged-4ab61e113949ca4f4f29/${name}`,
    tag, name, true,
  ), true);
  assert.equal(isExpectedAssetUrl(
    `https://github.com.evil.invalid/yuchen0x1/apkstart/releases/download/untagged-4ab61e113949ca4f4f29/${name}`,
    tag, name, true,
  ), false);
  assert.equal(isExpectedAssetUrl(
    `https://github.com/yuchen0x1/apkstart/releases/download/untagged-abc/${name}?token=secret`,
    tag, name, true,
  ), false);
  assert.equal(isExpectedAssetUrl(
    `https://github.com/yuchen0x1/apkstart/releases/download/untagged-abc/Other.exe`,
    tag, name, true,
  ), false);
  assert.equal(isExpectedAssetUrl(
    `https://github.com/yuchen0x1/apkstart/releases/download/untagged-abc/${name}`,
    tag, name, false,
  ), false);
});
