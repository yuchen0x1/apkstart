'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { scriptValue } = require('./lib/renderer-script');

test('renderer script values preserve JSON data including quotes and Unicode', () => {
  const value = {
    selector: '#dialog [data-name="\\path"]',
    text: '中文\n\r\t\0\b\f"\'\\\u2028\u2029',
    values: [null, true, false, 1.25, '<>&/'],
  };
  const result = vm.runInNewContext(`(${scriptValue(value)})`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), value);
});

test('renderer script values cannot terminate a script or add executable code', () => {
  const value = '</script><script>globalThis.injected=true</script>";globalThis.injected=true;//\u2028\u2029';
  const encoded = scriptValue(value);
  assert.doesNotMatch(encoded, /[<>&/\u2028\u2029]/);
  const context = vm.createContext({});
  assert.equal(vm.runInContext(`(() => { const value=${encoded}; return value; })()`, context), value);
  assert.equal(context.injected, undefined);
});

test('renderer script values reject unsupported top-level values', () => {
  for (const value of [undefined, () => true, Symbol('value')]) {
    assert.throws(() => scriptValue(value), TypeError);
  }
});
