'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { releaseFileNames, repo } = require('../src/core/release-manifest');

const repository = new URL(repo).pathname.slice(1);
const releaseFields = 'tagName,targetCommitish,isDraft,isPrerelease,body,assets';

function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || '');
        reject(error);
      } else resolve(String(stdout || ''));
    });
  });
}

function errorStatus(error) {
  return Number(error?.status) || Number(/\bHTTP\s+(\d{3})\b/i.exec(`${error?.stderr || ''}\n${error?.message || ''}`)?.[1]) || 0;
}

function isRetryable(error) {
  const status = errorStatus(error);
  if (status) return status === 429 || (status >= 500 && status <= 599);
  if (error?.killed || /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_CLOSED)$/.test(error?.code || '')) return true;
  return /(?:TLS handshake timeout|connection reset|connection refused|\bEOF\b|i\/o timeout|context deadline exceeded|dial tcp|no such host|network is unreachable)/i
    .test(`${error?.stderr || ''}\n${error?.message || ''}`);
}

function isMissing(error) {
  return errorStatus(error) === 404 || /(?:^|\n)release not found\s*$/i.test(String(error?.stderr || error?.message || '').trim());
}

function isAlreadyCreated(error) {
  return errorStatus(error) === 422 && /already[_ ]exists/i.test(`${error?.stderr || ''}\n${error?.message || ''}`);
}

function sameNotes(a, b) {
  return String(a || '').replace(/\r\n/g, '\n').trim() === String(b || '').replace(/\r\n/g, '\n').trim();
}

async function publishRelease({
  tag, artifactDir, notesPath, expectedTarget, version = require('../package.json').version,
  run = (args) => command('gh', args, { timeout: args[1] === 'upload' ? 600000 : 120000 }),
  verify = (mode, dir, uploaded, latest) => command(process.execPath, [
    path.join(__dirname, 'sign-release.js'), mode, dir, uploaded, latest,
  ], { env: { ...process.env, TAG: tag } }),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = 4,
} = {}) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || tag !== `v${version}`) throw new Error('Release tag does not match the package version');
  if (!/^[a-f0-9]{40}$/i.test(expectedTarget || '')) throw new Error('Release target must be an exact commit SHA');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) throw new Error('Invalid release retry limit');
  artifactDir = path.resolve(artifactDir);
  notesPath = path.resolve(notesPath);
  const names = fs.readdirSync(artifactDir).sort();
  if (JSON.stringify(names) !== JSON.stringify(releaseFileNames(tag))) throw new Error('Unexpected release files');
  if (names.some((name) => !fs.statSync(path.join(artifactDir, name)).isFile() || !fs.statSync(path.join(artifactDir, name)).size)) throw new Error('Empty or invalid release file');
  const notes = fs.readFileSync(notesPath, 'utf8');
  const gh = (args) => run([...args, '--repo', repository]);
  const pause = (attempt) => sleep(Math.min(30000, 1000 * (2 ** attempt)));
  const retry = async (operation) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await operation(); } catch (error) {
        if (!isRetryable(error) || attempt + 1 >= maxAttempts) throw error;
        await pause(attempt);
      }
    }
  };
  const read = () => retry(async () => {
    try { return JSON.parse(await gh(['release', 'view', tag, '--json', releaseFields])); } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  });
  const scope = (release) => {
    if (!release || release.tagName !== tag || release.targetCommitish !== expectedTarget || release.isPrerelease !== false
      || typeof release.isDraft !== 'boolean') throw new Error('Release tag, target or state differs; refusing to modify it');
    return release;
  };
  const draft = async () => {
    const release = scope(await read());
    if (!release.isDraft) throw new Error('Release is already published; refusing to upload or replace assets');
    return release;
  };
  const verifyRemote = async (release) => {
    scope(release);
    if (!sameNotes(release.body, notes)) throw new Error('Release notes differ from the signed release notes');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-release-'));
    try {
      await retry(() => gh(['release', 'download', tag, '--pattern', 'latest.json', '--dir', temp, '--clobber']));
      const uploaded = path.join(temp, 'uploaded.json');
      fs.writeFileSync(uploaded, JSON.stringify({ assets: release.assets }));
      await verify(release.isDraft ? '--check-draft' : '--check-upload', artifactDir, uploaded, path.join(temp, 'latest.json'));
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  };

  let release = await read();
  if (!release) {
    for (let attempt = 0; ; attempt += 1) {
      let failure;
      try {
        await gh(['release', 'create', tag, '--draft', '--verify-tag', '--target', expectedTarget, '--title', `ApkStart ${tag}`, '--notes-file', notesPath]);
      } catch (error) {
        if (!isRetryable(error) && !isAlreadyCreated(error)) throw error;
        failure = error;
      }
      // A timeout can arrive after GitHub committed the creation. Read back by
      // tag before retrying so that an existing draft is resumed, never deleted.
      release = await read();
      if (release) break;
      if (attempt + 1 >= maxAttempts) throw failure || new Error('Created release did not become visible');
      await pause(attempt);
    }
  }
  scope(release);
  if (!release.isDraft) {
    await verifyRemote(release);
    return { tag, alreadyPublished: true };
  }

  await retry(async () => {
    await draft();
    return gh(['release', 'edit', tag, '--notes-file', notesPath]);
  });
  await retry(async () => {
    await draft();
    return gh(['release', 'upload', tag, ...names.map((name) => path.join(artifactDir, name)), '--clobber']);
  });

  for (let attempt = 0; ; attempt += 1) {
    release = scope(await read());
    if (!release.isDraft) {
      await verifyRemote(release);
      return { tag, alreadyPublished: false };
    }
    await verifyRemote(release);
    let failure;
    try { await gh(['release', 'edit', tag, '--draft=false', '--latest']); } catch (error) {
      if (!isRetryable(error)) throw error;
      failure = error;
    }
    release = scope(await read());
    if (!release.isDraft) {
      await verifyRemote(release);
      return { tag, alreadyPublished: false };
    }
    if (attempt + 1 >= maxAttempts) throw failure || new Error('Release remained a draft after publication');
    await pause(attempt);
  }
}

module.exports = { publishRelease, isRetryable };

if (require.main === module) {
  (async () => {
    const [tag, artifactDir, notesPath] = process.argv.slice(2);
    const expectedTarget = (await command('git', ['rev-parse', 'HEAD^{commit}'])).trim();
    const tagTarget = (await command('git', ['rev-parse', `refs/tags/${tag}^{commit}`])).trim();
    if (tagTarget !== expectedTarget) throw new Error('Release tag does not point to the checked-out commit');
    const result = await publishRelease({ tag, artifactDir, notesPath, expectedTarget });
    console.log(`${result.alreadyPublished ? 'Verified existing release' : 'Published and verified'} ${result.tag}`);
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
