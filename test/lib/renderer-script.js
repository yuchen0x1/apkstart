'use strict';

// JSON 数据作为脚本字面量时额外转义 HTML 边界和 Unicode 行分隔符。
function scriptValue(value) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Renderer script values must be JSON-serializable');
  return json.replace(/[<>&/\u2028\u2029]/g, character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

module.exports = { scriptValue };
