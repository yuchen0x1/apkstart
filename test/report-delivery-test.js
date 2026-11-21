'use strict';
/** 纯内存出站/IPC 回归：不导入 main、store、engine，不发送真实网络请求。 */
const assert = require('assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReportDelivery } = require('../src/core/report-delivery');
const report = require('../src/core/report');
const endpoint = 'https://collector.example/report';
const bundle = report.buildBundle({ diagnosis: { code: 'TIMEOUT', title: '测试失败' } });

function delivery(approve = true) {
  const sent = [];
  const prompts = [];
  return {
    sent, prompts,
    api: createReportDelivery({
      post: async (...args) => { sent.push(args); return { ok: true }; },
      confirm: async (input) => { prompts.push(input); return approve; },
    }),
  };
}

test('默认、旧版 autoSend=true 和地址变更都不允许自动上报', async () => {
  const f = delivery();
  for (const settings of [{}, { auto: true }, { auto: true, autoSend: true }, { auto: true, autoSend: true, autoSendTo: 'https://previous.example/report' }, { auto: false, autoSend: true, autoSendTo: endpoint }]) {
    assert.equal((await f.api.send({ bundle, endpoint, automatic: true, settings })).skipped, 'no-consent');
  }
  assert.equal(f.sent.length, 0);
  assert.equal(f.prompts.length, 0);
});

test('自动上报只发给明确授权的同一个 HTTPS 地址', async () => {
  const f = delivery();
  const settings = { auto: true, autoSend: true, autoSendTo: endpoint };
  assert.equal((await f.api.send({ bundle, endpoint, automatic: true, settings })).ok, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.sent[0][2], 6000);
  const insecure = 'http://collector.example/report';
  assert.equal((await f.api.send({ bundle, endpoint: insecure, automatic: true, settings: { ...settings, autoSendTo: insecure } })).skipped, 'no-consent');
});

test('手动发送先确认目的地与摘要，取消不写网络', async () => {
  const cancelled = delivery(false);
  assert.equal((await cancelled.api.send({ bundle, endpoint })).cancelled, true);
  assert.equal(cancelled.sent.length, 0);
  assert.equal(cancelled.prompts[0].summary, bundle.summary);
  assert.equal(cancelled.prompts[0].endpoint, endpoint);
  const approved = delivery();
  assert.equal((await approved.api.send({ bundle, endpoint })).ok, true);
  assert.equal(approved.sent.length, 1);
  assert.equal(approved.sent[0][1], bundle.payload);
  assert.equal(approved.sent[0][2], 12000);
});

test('同一报告并发提交共享一次确认与一次 POST；完成后可以主动重试', async () => {
  const f = delivery();
  const a = f.api.send({ bundle, endpoint });
  const b = f.api.send({ bundle, endpoint });
  assert.equal(a, b);
  await Promise.all([a, b]);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.sent.length, 1);
  await f.api.send({ bundle, endpoint });
  assert.equal(f.sent.length, 2);
});

test('自动投递进行中仍需手动确认，取消手动发送不影响自动投递', async () => {
  let release;
  const inflight = new Promise((resolve) => { release = resolve; });
  const sent = [];
  let prompts = 0;
  const api = createReportDelivery({
    confirm: async () => { prompts++; return false; },
    post: async (_endpoint, body) => { sent.push(body); return inflight; },
  });
  const settings = { auto: true, autoSend: true, autoSendTo: endpoint };
  const automatic = api.send({ bundle, endpoint, automatic: true, settings });
  assert.equal((await api.send({ bundle, endpoint })).cancelled, true);
  assert.equal(prompts, 1);
  assert.deepEqual(sent, [bundle.automaticPayload]);
  release({ ok: true });
  assert.equal((await automatic).ok, true);
});

test('收集地址拒绝内嵌凭证、URL 片段和不规范分隔符', async () => {
  const f = delivery();
  for (const bad of ['https://user:password@collector.example/report', 'https://collector.example/report#part', 'https:///collector.example/report']) {
    assert.equal((await f.api.send({ bundle, endpoint: bad })).ok, false);
  }
  assert.equal(f.sent.length, 0);
  assert.equal(f.prompts.length, 0);
  const upper = 'HTTPS://collector.example/report';
  assert.equal((await f.api.send({ bundle, endpoint: upper, automatic: true, settings: { auto: true, autoSend: true, autoSendTo: upper } })).ok, true);
});

test('网络失败如实返回且不盲目重复发送，仍可由用户重试', async () => {
  let count = 0;
  const api = createReportDelivery({ confirm: async () => true, post: async () => { count++; throw new Error('offline'); } });
  assert.deepEqual(await api.send({ bundle, endpoint }), { ok: false, error: 'offline', uncertain: true });
  assert.equal(count, 1);
  assert.deepEqual(await api.send({ bundle, endpoint }), { ok: false, error: 'offline', uncertain: true });
  assert.equal(count, 2);
});

function ipcFixture(files = new Map(), reply = null) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const start = source.indexOf('  const REPORTS_DIR =');
  const end = source.indexOf("  ipcMain.handle('runtime:repairPlan'", start);
  assert(start > 0 && end > start, '报告 IPC 测试边界已变更，请同步测试');
  const handlers = new Map();
  const sent = [];
  const prompts = [];
  let approve = false;
  const responses = [];
  let tempSequence = 0;
  const randomUUID = () => `fixture-${++tempSequence}`;
  const settings = { report: { auto: true, endpoint } };
  const context = {
    path, URL, process: { platform: 'win32' }, feedback: report, mainWindow: {}, app: { getVersion: () => '0.0.0-test' },
    i18n: { t: (value) => value },
    store: { DATA_DIR: '/fixture', getSettings: () => settings },
    send() {}, buildRepairPlan: async () => null,
    runtime: {
      ensure: async () => ({ ok: false, error: 'fixture failed', diagnosis: context.lastDiagnosis() }),
      emulator: { recentLog: () => ['token=test-secret', 'ORDINARY LOG TAIL'], lastExitCode: null },
    },
    repairFacts: async () => ({ runtimeDir: '/private/runtime' }),
    lastDiagnosis: () => ({ code: 'TIMEOUT', title: 'fixture' }),
    ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
    fs: {
      mkdirSync() {},
      existsSync: (file) => files.has(file),
      openSync: (file) => {
        if (files.has(file)) {
          const error = new Error('EEXIST');
          error.code = 'EEXIST';
          throw error;
        }
        files.set(file, '');
        return file;
      },
      fsyncSync() {},
      closeSync() {},
      unlinkSync: (file) => { files.delete(file); },
      writeFileSync: (file, content) => files.set(file, content),
      readFileSync: (file) => {
        if (!files.has(file)) {
          const error = new Error('ENOENT: no such file, open \'' + file + '\'');
          error.code = 'ENOENT';
          throw error;
        }
        return files.get(file);
      },
      renameSync: (from, to) => {
        if (!files.has(from)) throw new Error('ENOENT');
        files.set(to, files.get(from));
        files.delete(from);
      },
    },
    randomUUID,
    // 真实原子写在 test/atomic-json-test.js 里用真文件校验；这里只要耐久语义。
    writeJsonAtomicSync: (file, data) => { files.set(file, JSON.stringify(data)); },
    createReportDelivery: (options) => createReportDelivery({
      ...options,
      post: async (...args) => {
        sent.push(args);
        return reply ? reply(...args) : { ok: true };
      },
    }),
    dialog: { showMessageBox: async (_win, options) => { prompts.push(options); return { response: responses.length ? responses.shift() : (approve ? 1 : 0) }; } },
    shell: { openPath() {}, openExternal() {}, showItemInFolder() {} },
    clipboard: { writeText() {} },
  };
  const runtimeStart = source.indexOf("  ipcMain.handle('runtime:start'");
  const runtimeEnd = source.indexOf('  // ---------------- 一键修复 ----------------', runtimeStart);
  assert(runtimeStart > 0 && runtimeEnd > runtimeStart, '开机 IPC 测试边界已变更，请同步测试');
  vm.runInNewContext(source.slice(runtimeStart, runtimeEnd) + source.slice(start, end) + '\nglobalThis.prepare = prepareFailureReport;', context);
  return { context, settings, handlers, files, sent, prompts, responses, approve: () => { approve = true; }, start: () => handlers.get('runtime:start')() };
}

test('真实报告 IPC：准备/预览完全离线；手动确认只发送一次', async () => {
  const f = ipcFixture();
  f.settings.report.autoSend = true;
  f.settings.report.autoSendTo = endpoint;
  assert.equal((await f.handlers.get('report:prepare')()).ok, true);
  assert.equal(f.sent.length, 0, '预览不得进入自动发送');
  assert.equal(f.prompts.length, 0);
  assert.equal((await f.handlers.get('report:submit')()).cancelled, true);
  assert.equal(f.sent.length, 0);
  f.approve();
  assert.equal((await f.handlers.get('report:submit')()).channel, 'endpoint');
  assert.equal(f.sent.length, 1, '手动准备与提交不得双发');
  assert(!JSON.stringify(f.sent[0][1]).includes('test-secret'));
  const prompt = f.prompts.at(-1);
  assert.equal(prompt.defaultId, 0);
  assert.equal(prompt.cancelId, 0);
  assert(prompt.detail.includes(endpoint));
  assert(prompt.detail.includes(JSON.stringify(f.sent[0][1], null, 2)), '确认必须展示实际完整 payload');
});

test('真实报告事件：默认离线；显式授权才自动发送；24h 去重', async () => {
  const local = ipcFixture();
  assert.equal((await local.start()).reportDraft.sent, false);
  assert.equal(local.sent.length, 0);
  const f = ipcFixture();
  f.settings.report.autoSend = true;
  f.settings.report.autoSendTo = endpoint;
  await f.context.prepare();
  assert.equal((await f.handlers.get('report:prepare')()).ok, true);
  assert.equal(f.sent.length, 0, '本地草稿不能触发自动发送');
  assert.equal((await f.start()).reportDraft.sent, true);
  assert.equal(f.sent.length, 1, '预览不应抢占自动发送的去重窗口');
  assert(!JSON.stringify(f.sent[0][1]).includes('ORDINARY LOG TAIL'), '自动上传不包含自由格式日志');
  assert.equal((await f.start()).reportDraft.skipped, 'recent');
  assert.equal(f.sent.length, 1);
});

test('真实开机 IPC：旧草稿不挡新授权，地址和签名分别去重，重启后仍保留', async () => {
  const f = ipcFixture();
  const first = (await f.start()).reportDraft;
  assert.equal(first.sent, false);
  assert.equal(f.sent.length, 0);
  Object.assign(f.settings.report, { autoSend: true, autoSendTo: endpoint });
  const cachedDraft = await f.context.prepare();
  assert.equal(cachedDraft.draft, first.file);
  assert.equal(cachedDraft.skipped, '', '仅复用本机草稿不是投递去重');
  const authorized = (await f.start()).reportDraft;
  assert.equal(authorized.file, first.file);
  assert.equal(authorized.sent, true);
  const diagnosis = f.context.lastDiagnosis;
  f.context.lastDiagnosis = () => ({ code: 'OTHER', title: 'fixture' });
  assert.equal((await f.start()).reportDraft.sent, true);
  f.context.lastDiagnosis = diagnosis;
  assert.equal((await f.start()).reportDraft.skipped, 'recent');
  const second = 'https://second.example/report';
  f.settings.report.endpoint = second;
  assert.equal((await f.start()).reportDraft.sent, false);
  f.settings.report.autoSendTo = second;
  assert.equal((await f.start()).reportDraft.sent, true);
  assert.deepEqual(f.sent.map(([url, payload]) => [url, payload.code]), [[endpoint, 'TIMEOUT'], [endpoint, 'OTHER'], [second, 'TIMEOUT']]);
  const restarted = ipcFixture(f.files);
  Object.assign(restarted.settings.report, f.settings.report);
  assert.equal((await restarted.start()).reportDraft.skipped, 'recent');
  assert.equal(restarted.sent.length, 0);
});

test('不确定的自动 POST 不盲目重放，明确拒收不算成功', async () => {
  let time = 1;
  let calls = 0;
  const api = createReportDelivery({
    now: () => time,
    confirm: async () => true,
    post: async () => {
      if (++calls === 1) return { ok: false, status: 429 };
      if (calls === 2) throw new Error('timeout');
      return { ok: true };
    },
  });
  const input = { bundle, endpoint, automatic: true, settings: { auto: true, autoSend: true, autoSendTo: endpoint } };
  assert.equal((await api.send(input)).status, 429);
  assert.equal((await api.send(input)).error, 'timeout');
  assert.equal((await api.send(input)).skipped, 'uncertain');
  assert.equal(calls, 2);
  time += 24 * 3600e3;
  assert.equal((await api.send(input)).ok, true);
  assert.equal(calls, 3);
});

test('兜底预览写明真实渠道、目的地和可检查摘要', async () => {
  const f = ipcFixture(new Map(), () => ({ ok: false, error: 'offline' }));
  f.settings.report.endpoint = endpoint;
  const prepared = await f.context.prepare();
  // 第一次弹窗是收集接口的发送确认，第二次才是兜底渠道选择。
  f.responses.push(1, 0);
  const result = await f.handlers.get('report:submit')();
  assert.equal(result.cancelled, true);
  assert.equal(f.sent.length, 1, '先尝试收集接口，失败后才进入兜底');
  assert.equal(f.prompts.length, 2);
  const prompt = f.prompts.at(-1);
  assert(prompt.detail.includes(endpoint), '必须写明收集接口地址');
  assert(prompt.detail.includes('offline'), '必须写明收集接口失败原因');
  assert(prompt.detail.includes('可能已经被接收'), '断线不能断言服务端没有收到');
  assert(prompt.detail.includes(prepared.bundle.summary.slice(0, 2400)), '必须展示可检查的摘要原文');
  assert(prompt.detail.includes('本机报告：'), '必须给出本机报告路径');
  assert(!/undefined|\[object Object\]/.test(prompt.detail));
  assert(prompt.buttons.length >= 2);
  assert.equal(prompt.buttons[0], '取消');
  assert.equal(prompt.cancelId, 0);
  assert.equal(prompt.defaultId, 1);
});

test('兜底预览在摘要过长时明说还有多少字没显示', async () => {
  const f = ipcFixture(new Map(), () => ({ ok: false, status: 502 }));
  f.settings.report.endpoint = endpoint;
  f.context.runtime.emulator.attempts = Array.from({ length: 12 }, (_, i) => ({
    plan: `方案 ${i} ${'长'.repeat(150)}`,
    diagnosis: '兼容性未知',
    timeout: true,
    exitCode: 1,
  }));
  const prepared = await f.context.prepare();
  f.responses.push(1, 0);
  assert.equal((await f.handlers.get('report:submit')()).cancelled, true);
  const prompt = f.prompts.at(-1);
  assert(prompt.detail.includes('HTTP 502'), '必须写明服务端状态');
  const hidden = /还有 (\d+) 字没显示/.exec(prompt.detail);
  assert(hidden && Number(hidden[1]) > 0, '超长摘要要说明剩余字数');
  assert.equal(Number(hidden[1]), prepared.bundle.summary.length - 2400, '剩余字数要与实际摘要一致');
});

test('关闭本地自动报告后失败事件不收集、不落盘也不上报', async () => {
  const f = ipcFixture();
  f.settings.report.auto = false;
  f.context.repairFacts = () => { throw new Error('不应收集'); };
  assert.equal(await f.context.prepare({ automatic: true }), null);
  assert.equal(f.files.size, 0);
  assert.equal(f.sent.length, 0);
});

/* ---------------- 回执耐久性与故障注入 ---------------- */

const auth = { auto: true, autoSend: true, autoSendTo: endpoint };
const automaticInput = { bundle, endpoint, automatic: true, settings: auth };

function memoryReceipts(initial = null) {
  let saved = initial;
  return {
    load: () => {
      if (saved === null) {
        const error = new Error('ENOENT: no such file');
        error.code = 'ENOENT';
        throw error;
      }
      return JSON.parse(saved);
    },
    save: (receipts) => { saved = JSON.stringify(receipts); },
    raw: () => saved,
  };
}

test('第一次使用没有回执文件时不阻断自动上报', async () => {
  const disk = memoryReceipts();
  let posts = 0;
  const api = createReportDelivery({
    post: async () => { posts++; return { ok: true }; },
    confirm: async () => true,
    loadReceipts: disk.load,
    saveReceipts: disk.save,
  });
  assert.equal((await api.send(automaticInput)).ok, true);
  assert.equal(posts, 1);
  assert.match(disk.raw(), /"state":"sent"/);
});

test('POST 之前就落盘不确定回执：请求途中进程退出，重启不会重发', async () => {
  const disk = memoryReceipts();
  let calls = 0;
  const first = createReportDelivery({
    // 永不返回，模拟请求发出后进程直接退出。
    post: () => { calls++; return new Promise(() => {}); },
    confirm: async () => true,
    loadReceipts: disk.load,
    saveReceipts: disk.save,
  });
  const inflight = first.send(automaticInput);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'POST 必须已经发出');
  assert.match(disk.raw() || '', /"state":"uncertain"/, 'POST 前必须已有耐久的不确定回执');

  const restarted = createReportDelivery({
    post: async () => { calls++; return { ok: true }; },
    confirm: async () => true,
    loadReceipts: disk.load,
    saveReceipts: disk.save,
  });
  assert.equal((await restarted.send(automaticInput)).skipped, 'uncertain');
  assert.equal(calls, 1, '重启后不得重发结果不确定的报告');
  inflight.catch(() => {});
});

test('回执保存失败时自动上报放弃，不发出无法去重的请求', async () => {
  let posts = 0;
  const api = createReportDelivery({
    post: async () => { posts++; return { ok: true }; },
    confirm: async () => true,
    saveReceipts: () => { throw new Error('EACCES: permission denied'); },
  });
  const result = await api.send(automaticInput);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'receipt-error');
  assert.match(result.error, /EACCES/);
  assert.equal(posts, 0, '保存不了回执就不应联网');
});

test('回执文件损坏或形状不合法时自动上报 fail closed，手动确认仍可发送', async () => {
  for (const broken of ['{not json', '[]x', '[{"key":"zz","state":"sent","at":1}]', '[{"key":"a".repeat(64),"state":"maybe","at":1}]']) {
    const disk = memoryReceipts(broken);
    let posts = 0;
    const api = createReportDelivery({
      post: async () => { posts++; return { ok: true }; },
      confirm: async () => true,
      loadReceipts: disk.load,
      saveReceipts: disk.save,
    });
    const auto = await api.send(automaticInput);
    assert.equal(auto.skipped, 'receipt-error', '坏回执不能当成从未发送：' + broken);
    assert.equal(posts, 0);
    assert.equal((await api.send({ bundle, endpoint })).ok, true, '手动发送仍可用');
    assert.equal(posts, 1);
  }
});

test('发送成功但回执补写失败时，磁盘仍是“不确定”，重启后不重发', async () => {
  const disk = memoryReceipts();
  let saves = 0;
  const api = createReportDelivery({
    post: async () => ({ ok: true }),
    confirm: async () => true,
    loadReceipts: disk.load,
    saveReceipts: (receipts) => {
      if (++saves === 1) return disk.save(receipts);
      throw new Error('ENOSPC: no space left');
    },
  });
  assert.equal((await api.send(automaticInput)).ok, true, '报告发送结果照实返回');
  assert.match(disk.raw() || '', /"state":"uncertain"/);
  let posts = 0;
  const restarted = createReportDelivery({
    post: async () => { posts++; return { ok: true }; },
    confirm: async () => true,
    loadReceipts: disk.load,
    saveReceipts: disk.save,
  });
  assert.equal((await restarted.send(automaticInput)).skipped, 'uncertain');
  assert.equal(posts, 0);
});

test('时钟回拨不会让已发送或不确定的回执立即失去去重保护', async () => {
  let time = 1_700_000_000_000;
  const disk = memoryReceipts();
  const post = async () => ({ ok: true });
  const api = createReportDelivery({
    now: () => time,
    post,
    confirm: async () => true,
    loadReceipts: disk.load,
    saveReceipts: disk.save,
  });
  assert.equal((await api.send(automaticInput)).ok, true);
  time -= 30 * 3600e3;
  const restarted = createReportDelivery({
    now: () => time,
    post,
    confirm: async () => true,
    loadReceipts: disk.load,
    saveReceipts: disk.save,
  });
  assert.equal((await restarted.send(automaticInput)).skipped, 'recent');
});

test('明确拒收（429）撤掉预留以便之后重试，5xx 与 408 保留不确定状态', async () => {
  const disk = memoryReceipts();
  let time = 1_700_000_000_000;
  const replies = [{ ok: false, status: 429 }, { ok: false, status: 503 }];
  const api = createReportDelivery({
    now: () => time,
    confirm: async () => true,
    post: async () => replies.shift(),
    loadReceipts: disk.load,
    saveReceipts: disk.save,
  });
  assert.equal((await api.send(automaticInput)).status, 429);
  assert(!/"state":"uncertain"/.test(disk.raw() || ''), '拒收不该留下预留');
  assert.equal((await api.send(automaticInput)).status, 503);
  assert.match(disk.raw() || '', /"state":"uncertain"/);
  assert.equal((await api.send(automaticInput)).skipped, 'uncertain');
});
