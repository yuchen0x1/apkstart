'use strict';
/**
 * 安卓系统设置：不需要进安卓桌面，也不用装第三方工具，
 * 直接通过 adb 把常用的系统开关做成 ApkStart 设置页里的按钮。
 * 所有命令都是官方 shell 接口，不依赖 root。
 */
const ACTIONS = {
  settings: 'android.settings.SETTINGS',
  wifi: 'android.settings.WIFI_SETTINGS',
  display: 'android.settings.DISPLAY_SETTINGS',
  sound: 'android.settings.SOUND_SETTINGS',
  locale: 'android.settings.LOCALE_SETTINGS',
  date: 'android.settings.DATE_SETTINGS',
  apps: 'android.settings.APPLICATION_SETTINGS',
  storage: 'android.settings.INTERNAL_STORAGE_SETTINGS',
  battery: 'android.settings.BATTERY_SAVER_SETTINGS',
  cast: 'android.settings.CAST_SETTINGS',
  dev: 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS',
};

/**
 * 解析 `cmd media_session volume --stream 3 --get` 的输出（也兼容 dumpsys audio 的片段）。
 * Android 11+ 移除了旧的 `media` 工具（报错 media: inaccessible or not found），
 * 替代命令的输出里带「当前音量 / 上限」两个数字（上限通常 15，不同设备可能不同）。
 *
 * 注意：不能「取输出里前两个整数」。真机输出是这样的（前面带 AudioService 的日志）：
 *   [V] will control stream=3 (STREAM_MUSIC)
 *   [V] will get volume
 *   [V] Connecting to AudioService
 *   [V] volume is 9 in range [0..15]
 * 按「前两个整数」解析会把 stream=3 当成当前音量、把 9 当成上限，
 * 于是设置页永远显示 33%，拖到 100% 也只落到 60%（9/15 档），
 * 而且校验永远失败、界面被状态刷新拽回旧值。
 * 所以只认明确的「当前 / 上限」写法，识别不出就返回 null，交给调用方回退/显示未知。
 * @returns {{cur:number, max:number}|null} 解析不出就返回 null
 */
function parseVolumeGet(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  const ok = (cur, max) => (Number.isFinite(cur) && Number.isFinite(max)
    && max > 0 && cur >= 0 && cur <= max ? { cur, max } : null);
  let m;

  // 1) 真机（Android 11+）：volume is 9 in range [0..15]
  m = /volume\s+is\s+(\d+)\s+in\s+range\s*\[\s*\d+\s*\.\.\s*(\d+)\s*\]/i.exec(s);
  if (m) return ok(Number(m[1]), Number(m[2]));

  // 2) dumpsys audio 片段：Max: 15 ... Current: 9 / streamVolume:9
  const dmax = /\bmax\s*[:=]\s*(\d+)/i.exec(s);
  const dcur = /(?:streamVolume|current)\s*[:=]\s*(\d+)/i.exec(s);
  if (dmax && dcur) return ok(Number(dcur[1]), Number(dmax[1]));

  // 3) 简洁写法：volume: 8/15
  m = /(\d+)\s*\/\s*(\d+)/.exec(s);
  if (m) return ok(Number(m[1]), Number(m[2]));

  // 4) 自然语言：Volume: 8 of 15 on stream 3
  m = /(\d+)\s+of\s+(\d+)/i.exec(s);
  if (m) return ok(Number(m[1]), Number(m[2]));

  // 5) 满档提示：15 (max 15)
  m = /(\d+)\s*\(\s*max\s*(\d+)\s*\)/i.exec(s);
  if (m) return ok(Number(m[1]), Number(m[2]));

  return null;
}

class AndroidSettings {
  constructor(runtime) {
    this.runtime = runtime;
    // 这台设备上 `cmd media_session volume --set` 到底管不管用：undefined=还没试过，
    // false=被 AudioService 拒绝过（改用音量键），true=正常工作。
    this._volumeSetWorks = undefined;
    // 上次读到的音量上限，省掉一次 adb 往返
    this._volumeMax = 0;
  }

  async client() {
    const rt = await this.runtime.ensure();
    if (!rt.ok) throw new Error(rt.error || '运行时未就绪');
    return rt.client;
  }

  async _sh(commands) {
    const c = await this.client();
    const script = commands.map((x) => `${x}; `).join('');
    return c.shell(script, { timeout: 20000 });
  }

  /** 读一批当前状态，供设置页显示 */
  async status() {
    const out = await this._sh([
      'echo "wifi=$(settings get global wifi_on)"',
      'echo "air=$(settings get global airplane_mode_on)"',
      'echo "font=$(settings get system font_scale)"',
      'echo "density=$(wm density | tail -n1 | tr -dc \'0-9\')"',
      'echo "animw=$(settings get global window_animation_scale)"',
      'echo "sdk=$(getprop ro.build.version.sdk)"',
      // Android 11+ 移除了 media 工具，音量统一走 cmd media_session（见 setVolume 注释）。
      // 这条命令会打好几行日志（[V] will control stream=3 …），echo 只取得到第一行，
      // 所以先用 tr 把换行压成空格，整段交给 parseVolumeGet；旧镜像没有 media_session
      // 时退回 dumpsys（同样压成一行，避免只截到 "- STREAM_MUSIC:"）。
      'echo "volget=$(cmd media_session volume --stream 3 --get 2>/dev/null | tr \'\\n\' \' \')"',
      'echo "volblk=$(dumpsys audio 2>/dev/null | grep -A8 STREAM_MUSIC | tr \'\\n\' \' \')"',
    ]);
    const get = (k) => {
      const m = new RegExp(`${k}=([^\\r\\n]*)`).exec(String(out));
      return m ? m[1].trim() : '';
    };
    const anim = get('animw');
    // 音量统一归一成 0-100 的百分比（UI 滑杆就是百分比）：media_session 的输出是
    // 「当前/上限」两个数字（上限通常 15），旧版直接把 0-15 的索引当百分比显示。
    // 读不出来时返回 null —— 不能兜成 0，否则设置页会把用户拖好的滑杆拽回 0%。
    const vg = parseVolumeGet(get('volget')) || parseVolumeGet(get('volblk'));
    const volume = vg ? Math.round((vg.cur / vg.max) * 100) : null;
    return {
      wifi: get('wifi') === '1',
      airplane: get('air') === '1',
      fontScale: Number(get('font')) || 1,
      density: Number(get('density')) || 0,
      volume,
      animationsOff: anim === '0.0' || anim === '0',
      sdk: Number(get('sdk')) || 0,
    };
  }

  async setWifi(on) {
    await this._sh([`svc wifi ${on ? 'enable' : 'disable'}`]);
    return { ok: true };
  }

  async setAirplane(on) {
    const v = on ? 1 : 0;
    await this._sh([
      `settings put global airplane_mode_on ${v}`,
      `am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${on ? 'true' : 'false'}`,
      `svc wifi ${on ? 'disable' : 'enable'}`,
      `svc data ${on ? 'disable' : 'enable'}`,
    ]);
    return { ok: true };
  }

  /**
   * 设置媒体音量（UI 传百分比 0-100）。
   * 旧实现 `media volume --stream 3 --set N` 在 Android 11+ 直接报错
   * 「media: inaccessible or not found」（issue #33），改用替代命令
   * `cmd media_session volume`，并把百分比对齐到设备的真实音量档位
   * （--set 的取值是 0..上限，上限从 --get 解析，拿不到就按常见的 15 档处理）。
   */
  /** 读一次媒体音量（当前档位 / 上限），读不到返回 null */
  async readVolume() {
    return parseVolumeGet(await this._sh(['cmd media_session volume --stream 3 --get']));
  }

  /**
   * 用音量键把档位从当前走到 target（--set 不可用时的唯一办法）。
   * 整段逻辑放在设备端跑：一次 adb 往返，循环里「读档位 → 按一下 → 再读」，
   * 自己收敛，不会像盲按那样冲过头。按键之间留 250ms —— 实测连按会被系统丢档，
   * 而每次按键本身有几毫秒到几十毫秒的启动开销，间隔太密效率反而更差。
   * @returns {Promise<number|null>} 走完之后回读到的档位
   */
  async _stepVolumeTo(target, max) {
    const readStep = 'cur=$(cmd media_session volume --stream 3 --get 2>/dev/null'
      + ' | grep -o "volume is [0-9]*" | cut -d" " -f3)';
    // 用换行分隔（不能用 '; ' 拼：mksh 不接受 `do;`）。
    // 每一轮按「当前到目标的差值」发几个按键（input 支持一次带多个 keycode，
    // 省掉最贵的 Java 进程启动），再回读校验；按丢了几档就下一轮补几档，
    // 所以不会按过头。一次最多 3 个：按键是排队逐个生效的，一批塞太多时
    // 回读拿到的还是「处理到一半」的值，下一轮就会重复补偿 → 冲过头。
    const script = [
      `t=${target}`,
      readStep,
      'i=0',
      `while [ -n "$cur" ] && [ "$cur" != "$t" ] && [ "$i" -lt ${Math.ceil(max / 3) + 3} ]; do`,
      '  if [ "$cur" -lt "$t" ]; then k=24; d=$((t-cur)); else k=25; d=$((cur-t)); fi',
      '  [ "$d" -gt 3 ] && d=3',
      '  ks=""; n=0',
      '  while [ "$n" -lt "$d" ]; do ks="$ks $k"; n=$((n+1)); done',
      '  input keyevent $ks',
      '  sleep 0.5',
      `  ${readStep}`,
      '  i=$((i+1))',
      'done',
      // 最后再等一下让按键结算完，并回读一次真实档位
      'sleep 0.5',
      `  ${readStep}`,
      'echo "VOLFINAL=$cur"',
    ].join('\n');
    // 一轮一个 adb 往返 + 若干档，慢机器上也可能十几秒，超时给宽一点
    const c = await this.client();
    const out = await c.shell(script, { timeout: 60000 });
    const m = /VOLFINAL=(\d+)/.exec(String(out));
    return m ? Number(m[1]) : null;
  }

  /**
   * 设置媒体音量（UI 传百分比 0-100）。
   * 旧实现 `media volume --stream 3 --set N` 在 Android 11+ 直接报错
   * 「media: inaccessible or not found」（issue #33），改用替代命令
   * `cmd media_session volume`，并把百分比对齐到设备的真实音量档位
   * （--set 的取值是 0..上限，上限从 --get 解析，拿不到就按常见的 15 档处理）。
   */
  async setVolume(percent) {
    const v = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    let after = await this.readVolume();
    if (after) this._volumeMax = after.max;
    const max = (after && after.max) || this._volumeMax || 15;
    const target = Math.max(0, Math.min(max, Math.round((v / 100) * max)));

    // ── 1) 先走官方接口 ──
    // `cmd media_session volume --set` 在多数机型上一步到位；但 Android 14 的
    // Play 镜像有平台 bug：AudioService 拿 callingPackage="com.android.server.media"
    // 去查 AppOps，uid 2000(shell) 名下没有这个包，于是抛
    // `SecurityException: com.android.server.media from uid 2000 not allowed to
    // perform AUDIO_MEDIA_VOLUME` —— 而 VolumeCmd 把这个异常吞掉了：命令返回 0、
    // 输出还写着 "will set volume to index=N"，音量却纹丝不动。
    // 所以必须回读确认；确认失败的机型记下来，之后直接走按键，不再白等一轮。
    if (this._volumeSetWorks !== false) {
      await this._sh([`cmd media_session volume --stream 3 --set ${target}`]);
      // 部分 Android 14 Google Play 镜像会接受 --set 但不刷新 AudioService 的实际档位，
      // 用音量键事件校正（见下），避免界面显示已调整而应用仍然静音。
      const got = await this.readVolume();
      if (got && got.cur === target) {
        this._volumeSetWorks = true;
        after = got;
      } else if (got) {
        this._volumeSetWorks = false;
        after = got;
      }
      // got 为 null（读不到）时不动这个判断，免得一次偶发读失败就把设备记成「--set 不通」
    }

    // ── 2) --set 不通就用音量键一档一档走 ──
    // 音量键走 MediaSessionService 的按键分发路径，调用方是前台应用，
    // 不受上面那个 AppOps bug 影响，是这类镜像上唯一还能改音量的办法。
    if (this._volumeSetWorks === false && after && after.cur !== target) {
      const cur = await this._stepVolumeTo(target, max).catch(() => null);
      if (cur !== null) after = { cur, max: after.max };
    }

    const actualVolume = after ? Math.round((after.cur / after.max) * 100) : null;
    return {
      ok: true,
      volume: v,
      actualVolume,
      // 供设置页在 Android 音频服务未及时刷新时显示真实状态；
      // 保留 ok=true 兼容旧调用方，初始化链路仍会严格校验。
      verified: !!after && after.cur === target,
    };
  }

  /** 关闭系统动画 = 明显的「变快」体感，且几乎不损失功能 */
  async setAnimations(on) {
    const v = on ? '1' : '0';
    await this._sh([
      `settings put global window_animation_scale ${v}`,
      `settings put global transition_animation_scale ${v}`,
      `settings put global animator_duration_scale ${v}`,
    ]);
    return { ok: true, animationsOff: !on };
  }

  async setFontScale(scale) {
    const v = Math.max(0.85, Math.min(1.3, Number(scale) || 1)).toFixed(2);
    await this._sh([`settings put system font_scale ${v}`]);
    return { ok: true, fontScale: Number(v) };
  }

  /** 显示大小：改 dpi，越大内容越大（相当于系统「显示大小」档位） */
  async setDensity(dpi) {
    const v = Math.max(120, Math.min(640, Math.round(Number(dpi) || 0)));
    if (!v) return { ok: false };
    await this._sh([`wm density ${v}`]);
    return { ok: true, density: v };
  }

  /** 一键整理：关动画 + 关遥测类服务 + 电池白名单，让应用更跟手 */
  async tune({ pkg } = {}) {
    const cmds = [
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put global activity_manager_constants max_cached_processes=32',
    ];
    if (pkg) cmds.push(`dumpsys deviceidle whitelist +${pkg}`);
    await this._sh(cmds);
    return { ok: true };
  }

  async open(action) {
    const a = ACTIONS[action] || ACTIONS.settings;
    const c = await this.client();
    await c.shell(`am start -a ${a}`, { timeout: 15000 });
    return { ok: true };
  }

  /** 应用运行时权限一览 + 授权 */
  async permissions(pkg) {
    const c = await this.client();
    const dump = await c.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const rows = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break;
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m) rows.push({ name: m[1], granted: m[2] === 'true' });
    }
    return rows;
  }

  async grantAll(pkg) {
    const c = await this.client();
    const rows = await this.permissions(pkg);
    const denied = rows.filter((r) => !r.granted).map((r) => r.name);
    for (const p of denied) {
      // eslint-disable-next-line no-await-in-loop
      await c.shell(`pm grant ${pkg} ${p}`, { timeout: 8000 }).catch(() => {});
    }
    return { ok: true, granted: denied.length };
  }
}

module.exports = { AndroidSettings, ACTIONS, parseVolumeGet };
