'use strict';
/** 在真实渲染页内执行的只读探针；渐变/图像上的文字另做视觉检查，不伪报全量WCAG认证。 */
function contrastProbe() {
  const parse = value => {
    const parts = String(value).match(/[\d.]+/g);
    return parts ? parts.map(Number) : [0, 0, 0, 0];
  };
  const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
  const luminance = rgb => rgb.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const failures = [], samples = [];
  const scope = document.querySelector('#repairMask.on, #wizardMask.on, #settingsMask.on') || document.body;
  let checked = 0, skipped = 0;
  for (const el of scope.querySelectorAll('*')) {
    if (!el.firstChild || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || ['SCRIPT','STYLE','OPTION'].includes(el.tagName)) continue;
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || rect.right < 0 || rect.left > innerWidth || rect.bottom < 0 || rect.top > innerHeight || style.visibility !== 'visible' || el.closest('[inert], [hidden], [disabled], [aria-disabled="true"]')) continue;
    const ancestors = []; let current = el, clipped = false, uncertain = false;
    while (current) {
      const st = getComputedStyle(current), r = current.getBoundingClientRect();
      if (+st.opacity < 1 || st.backgroundImage !== 'none') uncertain = true;
      if (current !== el && /(hidden|auto|scroll|clip)/.test(st.overflow + st.overflowY) && (rect.bottom < r.top || rect.top > r.bottom || rect.right < r.left || rect.left > r.right)) clipped = true;
      ancestors.push(st.backgroundColor); current = current.parentElement;
    }
    if (clipped) continue;
    if (uncertain) { skipped++; continue; }
    let bg = [255,255,255];
    for (const value of ancestors.reverse()) bg = blend(parse(value), bg);
    const fg = blend(parse(style.color), bg), l1 = luminance(fg), l2 = luminance(bg);
    const ratio = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
    const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && parseInt(style.fontWeight,10) >= 700);
    const required = large ? 3 : 4.5;
    checked++;
    const sample = { element: el.id || el.className || el.tagName, text: el.textContent.trim().slice(0,60), ratio: Math.round(ratio * 100) / 100, required, foreground: style.color, background: bg.map(Math.round) };
    if (samples.length < 8) samples.push(sample);
    if (ratio + 0.01 < required) failures.push(sample);
  }
  return { checked, skipped, failures, samples };
}
module.exports = { contrastProbe };
