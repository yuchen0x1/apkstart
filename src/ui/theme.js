'use strict';
/** 主窗口与应用外壳共用外观；设置为权威来源，本机缓存只用于避免首帧闪白。 */
(() => {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const normalize = value => ['system', 'light', 'dark'].includes(value) ? value : 'system';
  let preference = 'system';
  let busy = false;
  let revision = 0;
  try { preference = normalize(localStorage.getItem('apkstart.theme')); } catch (_) { /* 存储被禁用时仍可切换 */ }

  function apply(value) {
    revision += 1;
    preference = normalize(value);
    const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
    try { localStorage.setItem('apkstart.theme', preference); } catch (_) { /* 无持久缓存不影响本次使用 */ }
    const select = document.getElementById('setTheme');
    if (select) select.value = preference;
    window.dispatchEvent(new CustomEvent('apk-theme-applied', { detail: { preference, resolved } }));
  }

  async function save(value) {
    if (busy) return;
    const previous = preference;
    const next = normalize(value);
    const select = document.getElementById('setTheme');
    busy = true;
    if (select) { select.disabled = true; select.setAttribute('aria-busy', 'true'); }
    apply(next);
    try {
      const settings = await window.apkstart.setSettings({ theme: next });
      if (!settings || settings.theme !== next) throw new Error('外观设置未保存');
      apply(settings.theme);
    } catch (err) {
      apply(previous);
      const message = err && err.message || '请重试';
      if (typeof window.toast === 'function') window.toast({ title: '外观切换失败', body: message, type: 'error' });
      else console.warn('外观切换失败：' + message);
    } finally {
      busy = false;
      if (select) { select.disabled = false; select.removeAttribute('aria-busy'); }
    }
  }

  apply(preference);
  media.addEventListener('change', () => { if (preference === 'system') apply(preference); });
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('setTheme');
    if (select) {
      select.value = preference;
      select.addEventListener('change', () => save(select.value));
    }
    const requestedAt = revision;
    window.apkstart.getSettings().then(settings => {
      if (revision === requestedAt) apply(settings && settings.theme);
    }).catch(() => {});
    window.apkstart.on('theme:changed', state => { if (state) apply(state.preference); });
  }, { once: true });
  window.apkTheme = Object.freeze({ apply, save, get preference() { return preference; } });
})();
