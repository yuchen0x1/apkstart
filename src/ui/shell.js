'use strict';
/* 应用窗口标题栏：只有 旋转 / 最小化 / 最大化 / 关闭，其余设置都在 ApkStart 主界面 */
const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const btn = {
  rotate: $('btnRotate'),
  min: $('btnMin'),
  max: $('btnMax'),
  close: $('btnClose'),
};

btn.rotate.addEventListener('click', () => api.shell.rotate());
btn.min.addEventListener('click', () => api.shell.minimize());
btn.max.addEventListener('click', () => api.shell.maximize());
btn.close.addEventListener('click', () => api.shell.close());

// 标题栏上右键不要弹出 Chromium 的网页菜单；画面区域的右键已由主进程
// 拦下并映射成「安卓返回」，这里补掉外壳这一圈。
// 应用窗口的标题栏按钮 tooltip 也要跟着语言走（upstream #38）
api.i18n().then((p) => { if (window.apkI18n) window.apkI18n.apply(p); }).catch(() => {});

window.addEventListener('contextmenu', (e) => e.preventDefault());

// Ctrl+R 旋转，F11 最大化（和 Windows 习惯一致）
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); api.shell.rotate(); }
  else if (e.key === 'F11') { e.preventDefault(); api.shell.maximize(); }
  else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); api.shell.back(); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); api.shell.forward(); }
});

let bootTimer = null;
function applyState(s) {
  if (!s) return;
  $('appName').textContent = s.label || '应用';
  $('bootName').textContent = s.label || '';
  const icon = s.iconUrl || '';
  if (icon) {
    $('appIcon').src = icon;
    $('bootIcon').src = icon;
  }
  $('bootTip').textContent = s.tip || '';
  const boot = $('boot');
  if (s.ready === true || s.ready === false) {
    clearTimeout(bootTimer);
    $('stage').setAttribute('aria-busy', String(!s.ready));
    if (boot) {
      boot.setAttribute('aria-hidden', String(s.ready));
      if (s.ready) {
        boot.classList.add('out');
        bootTimer = setTimeout(() => { boot.hidden = true; }, 420);
      } else {
        boot.hidden = false;
        boot.classList.remove('out');
      }
    }
  }
}

let receivedState = false;
api.shell.onState((s) => { receivedState = true; applyState(s); });
api.shell.state().then((s) => {
  // 推送比启动时的快照更新，迟到的初始回复不能重新盖住已就绪的画面。
  if (!receivedState) applyState(s);
}).catch(() => {});
