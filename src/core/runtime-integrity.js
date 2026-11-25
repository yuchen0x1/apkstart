'use strict';
// 组件摘要只能来自此处固定的发布方记录或经 TLS 读取的 Google 官方索引。
// 设置、镜像、下载缓存均不是信任根；本模块不执行任何下载物或安装命令。
const fs = require('fs');
const crypto = require('crypto');
const { openStream } = require('./download');

const GOOGLE_REPOSITORY = 'https://dl.google.com/android/repository/repository2-3.xml';
const GOOGLE_BASE = 'https://dl.google.com/android/repository/';
const METADATA_LIMIT = 2 * 1024 * 1024;
const METADATA_TIMEOUT = 30000;

// 静态可信组件清单（2026-11-21 仅读取官方 metadata 核实，未下载/运行安装器）。
// https://www.qemu.org/download/#windows 指向 Stefan Weil 的 Windows 构建。
// 保留发布方 .sha512 的原始 sha512sum 记录；运行时绝不从镜像重新获取/覆盖摘要。
const QEMU_WINDOWS_SHA512_RECORD = '5bcf9eed634e8575a37b74f445af41a2fe4106da512d0c30c368301d4c105037fdfab40a5287367a28a957624cddebbc8c07e16c88ab6634f554cdf3d16bf543  qemu-w64-setup-20260811.exe';
const QEMU_WINDOWS = Object.freeze({
  version: '20260811',
  url: 'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  checksumSource: 'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.sha512',
  platform: 'win32',
  arch: 'x64',
});

function failure(message, code = 'RUNTIME_COMPONENT_UNVERIFIED') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function qemuManualHelp(host = process.platform) {
  if (host === 'linux') {
    return 'Linux 请自行使用发行版签名仓库的系统包管理器安装 QEMU'
      + '（Debian/Ubuntu：sudo apt install qemu-system-x86 qemu-utils）；本应用不会代执行命令。';
  }
  if (host === 'darwin') {
    return 'macOS 请自行使用可信系统包管理器安装 QEMU（Homebrew：brew install qemu）；本应用不会代执行命令。';
  }
  return '请通过 QEMU 官方入口 https://www.qemu.org/download/#windows 获取适合宿主的构建，'
    + '按发布方校验记录/签名验证后手动安装，并在设置中指定 QEMU 路径；'
    + '也可自行使用已配置可信源的系统包管理器。本应用不会申请管理员权限或代执行包管理命令。';
}

function checksumOf(component) {
  const checksum = component && component.checksum;
  const lengths = { sha1: 40, sha256: 64, sha512: 128 };
  if (!checksum || !Object.hasOwn(lengths, checksum.algorithm)
    || typeof checksum.value !== 'string'
    || !new RegExp(`^[0-9a-f]{${lengths[checksum.algorithm]}}$`, 'i').test(checksum.value)) {
    throw failure('组件没有有效的可信 checksum，已拒绝下载、解压或执行');
  }
  return checksum;
}

async function fetchGoogleRepository() {
  // openStream 保留端到端 TLS，并记录最终 URL。即使返回的是有效 XML，也不信任跨站重定向。
  const res = await openStream(GOOGLE_REPOSITORY, { timeout: METADATA_TIMEOUT });
  if (res.statusCode !== 200 || res.downloadUrl !== GOOGLE_REPOSITORY
    || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
    res.destroy();
    throw failure('Google 官方索引响应状态、最终来源或编码不可信，已拒绝自动安装 adb');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { reject(err); res.destroy(); }
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => finish(failure('Google 官方索引下载超时')), METADATA_TIMEOUT);
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > METADATA_LIMIT) { finish(failure('Google 官方索引超过大小上限')); return; }
      chunks.push(Buffer.from(chunk));
    });
    res.on('end', () => {
      const length = res.headers['content-length'];
      if (res.complete === false || !size || (length !== undefined && Number(length) !== size)) {
        finish(failure('Google 官方索引响应不完整'));
      } else finish();
    });
    res.on('aborted', () => finish(failure('Google 官方索引响应中断')));
    res.on('error', (err) => finish(err));
    res.on('close', () => { if (!done) finish(failure('Google 官方索引提前关闭')); });
  });
}

// 只解析官方索引中需要的受限结构，不展开 DTD、实体或 CDATA，不把注释当成包。
function elements(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'g'))];
}
function attribute(attrs, name) {
  const hits = [...attrs.matchAll(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([^"']*)\\1`, 'g'))];
  if (hits.length !== 1) throw failure(`Google 官方索引缺少或重复 ${name} 属性`);
  return hits[0][2];
}
function single(xml, tag) {
  const hits = elements(xml, tag);
  if (hits.length !== 1) throw failure(`Google 官方索引缺少或重复 ${tag}`);
  return hits[0];
}
function text(xml, tag) {
  const value = single(xml, tag)[2].trim();
  if (!value || /[<&]/.test(value)) throw failure(`Google 官方索引 ${tag} 无效`);
  return value;
}

function parsePlatformTools(input, host = process.platform, arch = process.arch) {
  const hosts = {
    win32: { os: 'windows', suffix: 'win', arches: ['x64'] },
    linux: { os: 'linux', suffix: 'linux', arches: ['x64'] },
    darwin: { os: 'macosx', suffix: 'darwin', arches: ['x64', 'arm64'] },
  };
  const target = Object.hasOwn(hosts, host) && hosts[host];
  if (!target || !target.arches.includes(arch)) {
    throw failure(`没有适合 ${host}/${arch} 的可信 platform-tools 包，请按 Android 官方说明手动安装`);
  }
  const source = String(input);
  if (/--!>/.test(source)) throw failure('Google 官方索引含无效的注释结束标记');
  const xml = source.replace(/<!--[\s\S]*?(?:--!>|-->)/g, '').trim();
  // A malformed or nested comment must fail closed; never pass a residual
  // comment marker into the restricted tag scanner.
  if (/<!--|-->/.test(xml)
    || /<!/.test(xml)
    || !/^(?:<\?xml[^?]*\?>\s*)?<((?:[\w-]+:)?sdk-repository)\b[^>]*>[\s\S]*<\/\1>\s*$/.test(xml)) {
    throw failure('Google 官方索引不是完整的 SDK repository XML');
  }
  const packages = elements(xml, 'remotePackage').filter((entry) => {
    if (attribute(entry[1], 'path') !== 'platform-tools' || /\bobsolete\s*=\s*["']true["']/.test(entry[1])) return false;
    const channels = [...entry[2].matchAll(/<channelRef\b([^>]*)\/?\s*>/g)];
    return channels.length === 1 && attribute(channels[0][1], 'ref') === 'channel-0'
      && !/<preview\b/.test(entry[2]);
  }).map((entry) => {
    const revision = single(entry[2], 'revision')[2];
    const parts = ['major', 'minor', 'micro'].map((part) => {
      const value = text(revision, part);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw failure('platform-tools 版本号无效');
      return Number(value);
    });
    return { xml: entry[2], parts, version: parts.join('.') };
  }).sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  const pkg = packages[0];
  if (!pkg || (packages[1] && pkg.version === packages[1].version)) {
    throw failure('Google 官方索引没有唯一的稳定版 platform-tools');
  }
  const archives = elements(single(pkg.xml, 'archives')[2], 'archive').filter((entry) => text(entry[2], 'host-os') === target.os);
  if (archives.length !== 1) throw failure(`Google 官方索引没有唯一的 ${target.os} platform-tools 归档`);
  const archive = archives[0][2];
  const hostArch = elements(archive, 'host-arch');
  if (hostArch.length && (hostArch.length !== 1 || text(archive, 'host-arch') !== arch)) {
    throw failure('platform-tools 归档的宿主架构不匹配');
  }
  const complete = single(archive, 'complete')[2];
  // 不接受 latest、外域、父路径、query 或与 revision/宿主不一致的归档。
  const filename = `platform-tools_r${pkg.version}-${target.suffix}.zip`;
  const rawUrl = text(complete, 'url');
  if (rawUrl !== filename && rawUrl !== GOOGLE_BASE + filename) throw failure('platform-tools 归档不是官方版本化 URL');
  const sum = single(complete, 'checksum');
  const checksum = Object.freeze({ algorithm: attribute(sum[1], 'type'), value: sum[2].trim().toLowerCase() });
  const sizeText = text(complete, 'size');
  const size = Number(sizeText);
  if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size) || size <= 0) throw failure('platform-tools 归档大小无效');
  const component = Object.freeze({ url: GOOGLE_BASE + filename, checksum, size, version: pkg.version, host, arch });
  checksumOf(component);
  return component;
}

async function resolveAdbComponent(host = process.platform, arch = process.arch) {
  // 先检查宿主，避免给不支持的宿主下载另一个平台的包。
  if (!((host === 'win32' || host === 'linux') && arch === 'x64')
    && !(host === 'darwin' && (arch === 'x64' || arch === 'arm64'))) {
    throw failure(`没有适合 ${host}/${arch} 的可信 platform-tools 包，请按 Android 官方说明手动安装`);
  }
  return parsePlatformTools(await fetchGoogleRepository(), host, arch);
}

function resolveQemuComponent(configured = '', host = process.platform, arch = process.arch) {
  const manual = qemuManualHelp(host);
  if (host !== QEMU_WINDOWS.platform || arch !== QEMU_WINDOWS.arch) {
    throw failure(`不支持在 ${host}/${arch} 自动安装 QEMU。${manual}`, 'QEMU_MANUAL_INSTALL_REQUIRED');
  }
  const record = /^([0-9a-f]{128})[ \t]+\*?qemu-w64-setup-20260811\.exe$/i.exec(QEMU_WINDOWS_SHA512_RECORD.trim());
  if (!record) throw failure(`没有固定的可信 QEMU SHA-512，已禁用自动下载安装。${manual}`, 'QEMU_UNVERIFIED');
  // 自定义 URL 只能作为同一固定版本的传输入口，绝不能连带指定/覆盖可信摘要。
  const url = String(configured || '').trim() || QEMU_WINDOWS.url;
  let parsed;
  try { parsed = new URL(url); } catch (_) { /* 下方失败关闭 */ }
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.href.includes('@') || parsed.hash) {
    throw failure(`QEMU 下载地址必须是无凭据的 HTTPS URL。${manual}`, 'QEMU_UNVERIFIED');
  }
  return Object.freeze({ ...QEMU_WINDOWS, url, checksum: Object.freeze({ algorithm: 'sha512', value: record[1].toLowerCase() }) });
}

async function verifyComponent(file, component) {
  const { algorithm, value } = checksumOf(component);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size
    || (component.size !== undefined && stat.size !== component.size)) {
    throw failure('组件文件类型或官方声明大小不符', 'RUNTIME_COMPONENT_INTEGRITY');
  }
  const actual = await new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  if (actual !== value.toLowerCase()) {
    throw failure(`${algorithm.toUpperCase()} 校验失败：下载内容与可信组件摘要不符，已拒绝解压或执行`, 'RUNTIME_COMPONENT_INTEGRITY');
  }
}

module.exports = { GOOGLE_REPOSITORY, QEMU_WINDOWS, resolveAdbComponent, parsePlatformTools, resolveQemuComponent, verifyComponent, qemuManualHelp };
