'use strict';
const { createHash } = require('crypto');
const AUTO_WINDOW_MS = 24 * 3600e3;
const MAX_AUTO_RECEIPTS = 128;

/** 报告出站边界：本地准备不应调用这里；手动确认与自动授权分别处理。 */
function createReportDelivery({ post, confirm, loadReceipts = () => [], saveReceipts = () => {}, now = Date.now }) {
  const pending = new Map();
  const receipts = new Map();
  let receiptError = '';
  try {
    const saved = loadReceipts();
    if (!Array.isArray(saved)) throw new Error('投递回执格式不合法');
    for (const receipt of saved.slice(-MAX_AUTO_RECEIPTS)) {
      if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.key) || !['sent', 'uncertain'].includes(receipt.state)
        || !Number.isFinite(receipt.at)) throw new Error('投递回执格式不合法');
      receipts.set(receipt.key, receipt);
    }
  } catch (e) {
    // 首次使用没有回执；其它读取错误不能当成从未发送，手动发送仍可使用。
    if (e.code !== 'ENOENT') receiptError = e.message;
  }

  function recentReceipt(key) {
    const receipt = receipts.get(key);
    const age = receipt && now() - receipt.at;
    // 时钟回拨不能使已发送/结果不确定的报告立即失去去重保护。
    return receipt && age < AUTO_WINDOW_MS ? receipt : null;
  }

  function persist() {
    try {
      saveReceipts([...receipts.values()]);
      return true;
    } catch (e) {
      receiptError = e.message;
      return false;
    }
  }

  function remember(key, state) {
    for (const oldKey of receipts.keys()) {
      if (!recentReceipt(oldKey)) receipts.delete(oldKey);
    }
    receipts.set(key, { key, state, at: now() });
    while (receipts.size > MAX_AUTO_RECEIPTS) receipts.delete(receipts.keys().next().value);
    return persist();
  }

  function send({ bundle, endpoint, automatic = false, settings = {} }) {
    if (!endpoint) return Promise.resolve({ ok: false, skipped: 'no-endpoint' });
    let url;
    try { url = new URL(endpoint); } catch (_) { return Promise.resolve({ ok: false, error: '上报地址不合法' }); }
    if (!/^https?:\/\/[^/]/i.test(endpoint) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
      return Promise.resolve({ ok: false, error: '上报地址只支持无内嵌凭证、无片段的 http(s) URL' });
    }
    if (automatic && !(settings.auto === true && settings.autoSend === true && settings.autoSendTo === endpoint && url.protocol === 'https:')) {
      return Promise.resolve({ ok: false, skipped: 'no-consent' });
    }
    const payload = automatic ? bundle.automaticPayload : bundle.payload;
    const { at: _at, ...content } = payload;
    const receiptKey = automatic
      ? createHash('sha256').update(JSON.stringify([url.href, bundle.signature])).digest('hex') : '';
    const key = receiptKey || JSON.stringify([endpoint, content]);
    if (pending.has(key)) return pending.get(key);
    const recent = receiptKey && recentReceipt(receiptKey);
    if (recent) return Promise.resolve({ ok: false, skipped: recent.state === 'sent' ? 'recent' : 'uncertain' });
    // 读不出历史回执时不能当成“从未发过”，只能拦下自动发送；手动仍可确认后发送。
    if (automatic && receiptError) {
      return Promise.resolve({
        ok: false,
        skipped: 'receipt-error',
        error: `无法读取投递回执，已停止自动上报：${receiptError}`,
      });
    }

    const task = Promise.resolve().then(async () => {
      if (!automatic && !await confirm({ endpoint, summary: bundle.summary, payload })) {
        return { ok: false, cancelled: true };
      }
      if (receiptKey) {
        // POST 之前先落盘“结果不确定”：请求途中进程退出也不会在重启后重发。
        // 保存失败就不发，避免出现无法去重的重复投递。
        if (!remember(receiptKey, 'uncertain')) {
          return {
            ok: false,
            skipped: 'receipt-error',
            error: `无法保存投递回执，已取消自动上报：${receiptError}`,
          };
        }
      }
      let result;
      try {
        result = await post(endpoint, payload, automatic ? 6000 : 12000);
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      const rejected = result.status >= 400 && result.status < 500 && result.status !== 408;
      if (receiptKey && result.ok) remember(receiptKey, 'sent');
      // 超时、断连或服务端异常时无法确认远端是否已接收，不要自动重放。
      if (receiptKey && !result.ok && rejected) {
        receipts.delete(receiptKey);
        persist();
      }
      return !result.ok && !rejected ? { ...result, uncertain: true } : result;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return { send };
}

module.exports = { createReportDelivery };
