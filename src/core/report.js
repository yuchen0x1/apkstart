'use strict';
/**
 * 失败报告：自动收集 → 脱敏 → 交给用户一键提交（或按配置直传）
 *
 * 为什么不直接静默上传：
 *  - 报告里有用户名路径、CPU 型号、装了哪些应用，属于可识别信息，用户有权先看一眼；
 *  - 客户端里不能塞 GitHub token（反编译即泄露），所以「自动」只能做到
 *    「自动生成 + 自动填好提交页」，最后那一下由用户点。
 *  - 想做到全自动，把 settings.report.endpoint 指向自己的收集接口，
 *    另行设置 autoSend 与同一 HTTPS 地址的 autoSendTo 才允许自动发送。
 *
 * 本模块保持纯函数（除 contact() 读 package.json），便于单测。
 */
const os = require('os');
const crypto = require('crypto');

const MAX_ISSUE_BODY = 5200;   // GitHub 的 new-issue URL 有长度上限，留足余量
const MAX_SUMMARY = 6000;
const MAX_ATTEMPTS = 12;

function clipText(value, limit) {
  return String(value || '').toWellFormed().slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
}

/** 收集端和日志属于不同信任边界，出站摘要只保留诊断所需的信息。 */
function publicFacts(facts, clean) {
  const accel = facts.accel || {};
  const image = facts.image || {};
  const num = (value) => Number.isFinite(value) ? value : 0;
  return {
    platform: facts.platform === 'linux' ? 'linux' : (facts.platform === 'win32' ? 'win32' : ''),
    osRelease: clean(facts.osRelease),
    arch: clean(facts.arch),
    cpuModel: clean(facts.cpuModel),
    vendor: clean(facts.vendor),
    vm: !!facts.vm,
    cores: num(facts.cores),
    totalMB: num(facts.totalMB),
    freeMB: num(facts.freeMB),
    freeDiskMB: num(facts.freeDiskMB),
    emulatorVersion: clean(facts.emulatorVersion),
    accel: { ok: !!accel.ok, kind: clean(accel.kind), suspect: !!accel.suspect },
    image: { api: clean(image.api), tag: image.custom ? '' : clean(image.tag), compat: !!image.compat, custom: !!image.custom },
    tuned: !!facts.tuned,
  };
}

/** 作者的联系方式：仓库与邮箱都从 package.json 的 feedback 读，便于发布方自行改 */
function contact() {
  let pkg = {};
  try { pkg = require('../../package.json'); } catch (_) { /* 打包后路径异常时降级 */ }
  const fb = (pkg && pkg.feedback) || {};
  const repoFromUrl = ((pkg.repository && String(pkg.repository.url || ''))
    .match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/) || [])[1] || '';
  return {
    repo: String(fb.repo || repoFromUrl || '').trim(),
    email: String(fb.email || '').trim(),
    // 发行版可以提供手动上报目的地；这不是自动发送许可。
    endpoint: String(fb.endpoint || '').trim(),
    version: String((pkg && pkg.version) || '').trim(),
    name: String((pkg && pkg.productName) || 'ApkStart').trim(),
  };
}

/**
 * 脱敏：把家目录、用户名、临时目录换成占位符。
 * 日志里最常见的是 `C:\Users\lenmo\AppData\...`，直接发出去等于把用户名公开。
 */
function redact(text, { home = os.homedir(), tmp = os.tmpdir(), extra = [] } = {}) {
  let out = String(text == null ? '' : text).replace(ANSI, '');
  const pairs = [];
  const push = (from, to) => { if (from && String(from).length > 3) pairs.push([String(from), to]); };
  push(home, '%USERPROFILE%');
  push(home.replace(/\\/g, '/'), '%USERPROFILE%');
  push(home.replace(/\\/g, '\\\\'), '%USERPROFILE%');
  push(tmp, '%TEMP%');
  push(tmp.replace(/\\/g, '/'), '%TEMP%');
  for (const e of extra) push(e, '%PATH%');
  // 路径大小写不敏感：Windows 上 C:\Users\Lenmo 与 c:\users\lenmo 是同一个地方
  pairs.sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of pairs) {
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, to);
  }
  // 兜底：任何残留的 C:\Users\<name>（换了 shell / 短路径写法）
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '%USERPROFILE%');
  out = out.replace(/[A-Za-z]:\/Users\/[^/\s"']+/gi, '%USERPROFILE%');
  out = out.replace(/\/(?:Users|home)\/[^/\s"']+/g, '%USERPROFILE%');
  // 先擦凭证再裁剪：短 token、带引号的 JSON 及 URL 查询参数也不能进入报告。
  out = out.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]');
  out = out.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@');
  out = out.replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9+/=._~-]+/gi, '$1[REDACTED]');
  out = out.replace(/(["'](?:set-cookie|cookie|authorization|proxy-authorization)["']\s*:\s*)\[\s*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(?:\s*,\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))*\s*)?\]/gi, '$1"[REDACTED]"');
  out = out.replace(/(\b(?:set-cookie|cookie|authorization|proxy-authorization):[ \t]*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi, '$1[REDACTED]');
  out = out.replace(/([?&][^?=&\s]*(?:token|secret|key|password|signature|sig|credential)\s*=)[^&#\s"'<>]+/gi, '$1[REDACTED]');
  out = out.replace(/(["']?[\w.-]*(?:pubkey|api[_-]?key|access[_-]?key|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;<>]+)/gi,
    '$1[REDACTED]');
  return out;
}

/** 报告指纹：同一台机器、同一个结论、同一个版本 = 同一份报告，避免重复刷屏 */
function signature({ facts = {}, diagnosis = {}, version = '' } = {}) {
  const key = [
    version,
    diagnosis.code || '',
    facts.cpuModel || '',
    facts.osRelease || '',
    facts.accel && facts.accel.ok ? 'accel' : 'noaccel',
    facts.vm ? 'vm' : 'pc',
  ].join('|');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/** 日志里的 ANSI 颜色码：报告是纯文本，留着只会白占字符预算 */
const ANSI = /\u001b\[[0-9;]*m/g;
/**
 * 单行压缩上限。
 *
 * 一条 `androidboot.qemu.adb.pubkey=` 就有 700 字符、在日志里还会出现两次，
 * 而 clipLog 的总预算只有 2200 —— 真正有用的错误行就是这么被挤出去的
 * （用户拿到的报告里日志末尾全是 boot properties，最后一行恰好停在 veritymode，
 * 真正的 `emulator exit 1` 反而看不见）。
 */
const LINE_MAX = 240;

/** 剥 ANSI + 省略密钥长串 + 截断超长行，三步都只为「别把错误行挤出预算」 */
function shrinkLine(line) {
  let s = String(line).replace(ANSI, '').replace(/\s+$/, '');
  s = s.replace(/\b([\w.-]*(?:pubkey|api[_-]?key|token|secret|password))\s*=\s*[A-Za-z0-9+/=._-]{24,}/gi,
    '$1=…（已省略）');
  if (s.length > LINE_MAX) {
    const cut = s.length - LINE_MAX;
    s = `${s.slice(0, LINE_MAX)}…（本行还有 ${cut} 字符）`;
  }
  return s;
}

/** 把日志裁到「够定位」的长度，别把 300 行全塞进 issue */
function clipLog(lines, maxLines = 60, maxChars = 2200) {
  const arr = (Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/))
    .map(shrinkLine)
    .filter((s) => s && !/^正在开机… \d+s$/.test(s));
  const tail = arr.slice(-maxLines);
  let text = tail.join('\n');
  if (text.length > maxChars) text = `…（前面已省略）\n${text.slice(-maxChars)}`;
  return text;
}

/** 失败报告正文（Markdown）：一段话能看懂，复制进 issue 就是完整线索 */
function buildSummary({ facts = {}, diagnosis = {}, attempts = [], exitCode = null, logLines = [], extra = {} } = {}) {
  const c = contact();
  const d = diagnosis || {};
  const f = facts || {};
  const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} GB` : `${Math.round(n || 0)} MB`);
  const accel = f.accel && f.accel.ok
    ? `${f.accel.kind === 'whpx' ? 'WHPX' : (f.accel.kind === 'aehd' ? 'AEHD' : '可用')}`
    : '不可用（纯软件模拟）';
  const rows = [
    ['版本', c.version || extra.appVersion || '未知'],
    ['结论', `${d.code || 'UNKNOWN'}：${d.title || '未判定'}`],
    ['系统', `${(f.platform || process.platform) === 'linux' ? 'Linux' : 'Windows'} ${f.osRelease || '?'} ${f.arch || ''}`.trim()],
    ['CPU', `${f.cpuModel || '未识别'}${f.cores ? ` · ${f.cores} 核` : ''}`],
    ['内存', `${mb(f.totalMB)}${f.freeMB ? `（可用 ${mb(f.freeMB)}）` : ''}`],
    ['硬件加速', accel],
    ['运行环境', f.vm ? `虚拟机 / 云电脑${f.vendor ? `（${f.vendor}）` : ''}` : '物理机'],
    ['系统镜像', f.image && f.image.api ? `Android ${f.image.api} · ${f.image.tag || ''}${f.image.compat ? ' · ARM 转译' : ''}` : '未就绪'],
    ['退出码', exitCode == null ? '无（进程未崩溃）' : `${exitCode}`],
  ];
  const tried = (attempts || []).filter(Boolean);
  const lines = [];
  lines.push(`### 开机失败报告 · ${d.title || '未判定'}`);
  lines.push('');
  lines.push('| 项目 | 值 |');
  lines.push('| --- | --- |');
  for (const [k, v] of rows) lines.push(`| ${k} | ${String(v).replace(/\|/g, '/')} |`);
  if (tried.length) {
    lines.push('');
    lines.push('**自动尝试过的参数**');
    for (const a of tried) {
      lines.push(`- ${a.plan || '未知'} → ${a.diagnosis || '未判定'}${a.timeout ? '（超时）' : ''}${a.exitCode ? ` · 退出码 ${a.exitCode}` : ''}`);
    }
  }
  if (d.hint) {
    lines.push('');
    lines.push('**程序给出的建议**');
    lines.push(String(d.hint));
  }
  const log = (logLines || []).length ? clipLog(logLines) : '';
  if (log) {
    lines.push('');
    lines.push('**运行时日志（末尾）**');
    lines.push('```');
    lines.push(log);
    lines.push('```');
  }
  lines.push('');
  lines.push('---');
  lines.push('由 ApkStart 自动生成的诊断摘要；完整报告（含环境快照）已保存在用户本机，可在对话中附上。');
  return lines.join('\n');
}

/** GitHub 新建 issue 的预填地址（不需要 token，用户点一下即可提交） */
function issueUrl({ summary, repo, version }) {
  const r = repo || contact().repo;
  if (!r) return '';
  const title = `[自动上报] 开机失败 · ${contact().name} ${version || ''}`.replace(/\s+/g, ' ').trim();
  const prefix = `https://github.com/${r}/issues/new?title=${encodeURIComponent(title)}&body=`;
  // URL 预算按编码后的长度算，中文和 emoji 不能按 JS 字符数直接截断。
  const chars = Array.from(clipText(summary, MAX_ISSUE_BODY));
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (prefix.length + encodeURIComponent(chars.slice(0, mid).join('')).length <= 7800) lo = mid;
    else hi = mid - 1;
  }
  return prefix + encodeURIComponent(chars.slice(0, lo).join(''));
}

/** 邮件兜底：没有 GitHub 账号的用户也能发（不带附件及本地报告路径） */
function mailtoUrl({ summary, email, version }) {
  const to = email || contact().email;
  if (!to) return '';
  const subject = `[ApkStart ${version || ''}] 开机失败报告`.replace(/\s+/g, ' ').trim();
  const body = clipText(summary, 3500);
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * 组装一份可直接提交的报告包。
 * @param {object} ctx 由主进程提供：诊断、事实、尝试、日志、报告文件路径
 */
function buildBundle(ctx = {}) {
  const c = contact();
  const home = ctx.home || os.homedir();
  const tmp = ctx.tmp || os.tmpdir();
  const rawFacts = ctx.facts || {};
  const extra = [...(ctx.redactPaths || []), rawFacts.runtimeDir].filter((s) => typeof s === 'string');
  const clean = (value) => redact(typeof value === 'string' || typeof value === 'number' ? String(value) : '', { home, tmp, extra });
  const bounded = (value, limit) => clipText(clean(value), limit);
  const facts = publicFacts(rawFacts, (value) => bounded(value, 300));
  const diagnosis = {
    code: bounded(ctx.diagnosis && ctx.diagnosis.code, 32),
    title: bounded(ctx.diagnosis && ctx.diagnosis.title, 200),
    hint: bounded(ctx.diagnosis && ctx.diagnosis.hint, 600),
  };
  const attempts = (Array.isArray(ctx.attempts) ? ctx.attempts : []).filter((a) => a && typeof a === 'object').slice(-MAX_ATTEMPTS).map((a) => ({
    plan: bounded(a.plan, 300),
    diagnosis: bounded(a.diagnosis, 300),
    timeout: !!a.timeout,
    exitCode: Number.isFinite(a.exitCode) ? a.exitCode : null,
  }));
  const exitCode = Number.isFinite(ctx.exitCode) ? ctx.exitCode : null;
  const rawSummary = buildSummary({
    facts, diagnosis, attempts, exitCode,
    logLines: clean((Array.isArray(ctx.logLines) ? ctx.logLines : []).join('\n')).split(/\r?\n/),
    extra: ctx.extra || {},
  });
  const summary = clipText(clean(rawSummary), MAX_SUMMARY);
  const sig = signature({ facts, diagnosis, version: c.version });
  const at = new Date().toISOString();
  const payload = { signature: sig, version: c.version, at, code: diagnosis.code || 'UNKNOWN', title: diagnosis.title || '', facts, attempts, exitCode, summary };
  // 无人确认的自动发送不包含自由格式的日志末尾，也不发送日志里的额外上下文。
  const automaticPayload = {
    ...payload,
    summary: clean(buildSummary({ facts, diagnosis, attempts, exitCode, extra: ctx.extra || {} })).slice(0, MAX_SUMMARY),
  };
  return {
    id: `${at.replace(/[:.]/g, '-')}-${sig}`,
    at,
    signature: sig,
    code: diagnosis.code || 'UNKNOWN',
    title: diagnosis.title || '开机失败',
    version: c.version,
    summary,
    issueUrl: issueUrl({ summary, repo: c.repo, version: c.version }),
    mailtoUrl: mailtoUrl({ summary, email: c.email, version: c.version, reportFile: ctx.reportFile || '' }),
    reportFile: ctx.reportFile || '',
    contact: c,
    payload,
    automaticPayload,
  };
}

module.exports = {
  contact, redact, signature, buildSummary, issueUrl, mailtoUrl, buildBundle,
  clipLog, shrinkLine, MAX_ISSUE_BODY,
};
