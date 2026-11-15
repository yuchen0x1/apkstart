/**
 * ApkStart 失败报告收集端（Cloudflare Worker）
 *
 * 为什么要自建这一层：
 *  - 客户端里不能放 GitHub token，而没有服务端又没法真正「自动上报」；
 *  - 有了这个端点，失败报告可以先脱敏再直传，服务端还能顺手转发到作者邮箱。
 *
 * 路由：
 *   POST /                提交报告（JSON），限流 + 体积上限
 *   GET  /health          存活检查
 *   GET  /reports?token=  最近 50 条的键（需要 ADMIN_TOKEN）
 *   GET  /r/<id>?token=   单条报告全文（需要 ADMIN_TOKEN）
 *
 * 绑定：
 *   REPORTS  —— KV namespace，存报告（保留 90 天）
 *   ADMIN_TOKEN（secret）—— 管理接口口令，不设则管理接口全部 403
 *   RESEND_API_KEY / MAIL_TO / MAIL_FROM（可选）—— 转发到邮箱
 *
 * 客户端对应配置：package.json → feedback.endpoint，或设置文件里的 report.endpoint。
 */

const MAX_BODY = 256 * 1024;       // 256 KB：摘要 + 结构化事实，足够，也防滥用
const TTL_SECONDS = 90 * 86400;    // 报告保留 90 天
const RATE_WINDOW = 60;            // 每 IP 60 秒一条

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
});

/** 常量时间比较，避免 token 被按位试探（Worker 里没有 timingSafeEqual，手写一个） */
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** 管理接口鉴权：token 放 query 或 Authorization: Bearer */
function adminOk(req, env) {
  if (!env.ADMIN_TOKEN) return false;
  const url = new URL(req.url);
  const given = url.searchParams.get('token')
    || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return safeEqual(given, env.ADMIN_TOKEN);
}

/** 每 IP 每分钟一条：KV 没有原子自增，用「分钟桶键」代替，够用且不会误伤 */
async function rateLimited(req, env) {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';
  const bucket = `rl:${ip}:${Math.floor(Date.now() / (RATE_WINDOW * 1000))}`;
  const seen = await env.REPORTS.get(bucket);
  if (seen) return true;
  await env.REPORTS.put(bucket, '1', { expirationTtl: RATE_WINDOW * 2 });
  return false;
}

/** 报告字段校验：只认客户端真正会发的那几项，其余丢弃 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = typeof raw.summary === 'string' ? raw.summary : '';
  if (summary.length < 20) return null;
  const sig = String(raw.signature || '').slice(0, 32);
  return {
    signature: sig || 'nosig',
    version: String(raw.version || '').slice(0, 32),
    at: String(raw.at || new Date().toISOString()).slice(0, 40),
    code: String(raw.code || 'UNKNOWN').slice(0, 32),
    title: String(raw.title || '').slice(0, 200),
    exitCode: raw.exitCode == null ? null : Number(raw.exitCode),
    facts: raw.facts && typeof raw.facts === 'object' ? raw.facts : {},
    attempts: Array.isArray(raw.attempts) ? raw.attempts.slice(0, 12) : [],
    summary: summary.slice(0, 20000),
  };
}

/** 转发到邮箱：没配 Resend 就静默跳过，绝不因为发信失败丢报告 */
async function notify(env, report) {
  if (!env.RESEND_API_KEY || !env.MAIL_TO) return;
  const f = env.fetchImpl || fetch;
  const subject = `[ApkStart] ${report.code} · ${report.version} · ${report.signature}`;
  try {
    await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'ApkStart <onboarding@resend.dev>',
        to: [env.MAIL_TO],
        subject,
        text: report.summary,
      }),
    });
  } catch (_) { /* 邮件失败不影响报告入库 */ }
}

export async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    return json({ ok: true, service: 'apkstart-reports', at: new Date().toISOString() });
  }

  if (req.method === 'POST' && (path === '/' || path === '/report')) {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > MAX_BODY) return json({ ok: false, error: '报告过大' }, 413);
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ ok: false, error: '报告过大' }, 413);

    let raw;
    try { raw = JSON.parse(text); } catch (_) { return json({ ok: false, error: '不是合法 JSON' }, 400); }
    const report = normalize(raw);
    if (!report) return json({ ok: false, error: '缺少 summary 等必要字段' }, 400);

    if (await rateLimited(req, env)) {
      return json({ ok: false, error: '提交太频繁，请稍后再试' }, 429, { 'retry-after': String(RATE_WINDOW) });
    }

    const id = `${report.at.replace(/[:.]/g, '-')}-${report.signature}`;
    await env.REPORTS.put(`report:${id}`, JSON.stringify(report), { expirationTtl: TTL_SECONDS });
    await notify(env, report);
    return json({ ok: true, id });
  }

  if (req.method === 'GET' && path === '/reports') {
    if (!adminOk(req, env)) return json({ ok: false, error: '未授权' }, 403);
    const listed = await env.REPORTS.list({ prefix: 'report:', limit: 50 });
    return json({ ok: true, count: listed.keys.length, keys: listed.keys.map((k) => k.name) });
  }

  if (req.method === 'GET' && path.startsWith('/r/')) {
    if (!adminOk(req, env)) return json({ ok: false, error: '未授权' }, 403);
    const id = decodeURIComponent(path.slice(3));
    const raw = await env.REPORTS.get(`report:${id}`);
    if (!raw) return json({ ok: false, error: '没有这条报告' }, 404);
    return new Response(raw, { headers: { 'content-type': 'application/json; charset=utf-8' } });
  }

  return json({ ok: false, error: 'not found' }, 404);
}

export default {
  fetch(req, env) {
    return handle(req, env);
  },
};
