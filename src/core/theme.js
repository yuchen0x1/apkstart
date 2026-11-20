'use strict';
/** 与 ui/tokens.css 的窗口背景 / 一级文字一致；不改变 Android 画面和应用图标。 */
const PALETTES = Object.freeze({
  light: Object.freeze({ background: '#f7f8fa', foreground: '#20252d' }),
  dark: Object.freeze({ background: '#1b1f26', foreground: '#e9edf3' }),
});
function normalizePreference(value) {
  return ['light', 'dark', 'system'].includes(value) ? value : 'system';
}
function nativePalette(dark) { return PALETTES[dark ? 'dark' : 'light']; }
function updateWindow(win, dark, { overlay = false } = {}) {
  if (!win || win.isDestroyed()) return;
  const palette = nativePalette(dark);
  win.setBackgroundColor(palette.background);
  if (overlay && typeof win.setTitleBarOverlay === 'function') {
    win.setTitleBarOverlay({ color: palette.background, symbolColor: palette.foreground, height: 44 });
  }
}
module.exports = { normalizePreference, nativePalette, updateWindow };
