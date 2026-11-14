'use strict';

/**
 * 「这个应用该用横屏还是竖屏 LCD」的纯决策逻辑。
 *
 * 为什么要单独一层：模拟器窗口的宽高比由 hw.lcd.width/height 在**开机时**锁死
 * （`wm size` 只改逻辑分辨率；`adb emu rotate` 只转窗口、安卓 rotation 仍为 0；
 * `resize-display` 只支持内置预设档且经常直接 KO）。所以横屏应用要铺满窗口，
 * 唯一的路是在启动运行时之前就把 LCD 定成横的 —— 也就是「方向」必须在
 * 拉模拟器之前算出来，而不是等嵌进窗口之后再想办法把画面掰过来。
 *
 * 这里只做决策，不碰 IO，方便单测覆盖「未知方向 / 用户强制 / 已在目标方向」这些分支。
 */

const LANDSCAPE = 'landscape';
const PORTRAIT = 'portrait';

/**
 * 应用期望的 LCD 方向。
 * @param {object} app  store 里的应用记录（含 apk.js 解析出的 orientation、用户选的 lcdPref）
 * @returns {'landscape'|'portrait'|''}  '' = 不干预，沿用当前/默认
 */
function desiredOrientation(app) {
  if (!app) return '';
  // 用户选过「保持当前」：不再为这个应用弹窗，也不再干预
  if (app.lcdPref === 'keep') return '';
  if (app.lcdPref === LANDSCAPE || app.lcdPref === PORTRAIT) return app.lcdPref;
  if (app.orientation === LANDSCAPE) return LANDSCAPE;
  if (app.orientation === PORTRAIT) return PORTRAIT;
  // 清单里没写（unspecified / sensor / 未知）：不猜。绝大多数是竖屏应用，
  // 猜成横屏会让它们全部变成两侧黑边，比「横屏游戏不铺满」严重得多。
  return '';
}

/**
 * 需要重启运行时才能满足这个方向吗？
 * @param {string} current 当前 LCD 方向（未知按竖屏算，与老版本行为一致）
 * @param {string} want    期望方向（'' 表示不干预）
 */
function needsRestart(current, want) {
  if (!want) return false;
  return (current === LANDSCAPE ? LANDSCAPE : PORTRAIT) !== want;
}

/** 把竖屏基准尺寸转成目标方向（像素数与 dpi 不变，只交换宽高） */
function orientBox(box, orientation) {
  if (!box || !box.w || !box.h) return box;
  const wantLandscape = orientation === LANDSCAPE;
  const isLandscape = box.w > box.h;
  if (wantLandscape === isLandscape) return box;
  return { ...box, w: box.h, h: box.w };
}

/** 给用户看的措辞 */
function label(orientation) {
  return orientation === LANDSCAPE ? '横屏' : '竖屏';
}

module.exports = { desiredOrientation, needsRestart, orientBox, label, LANDSCAPE, PORTRAIT };
