import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const entry = fileURLToPath(new URL('../multi-user.mjs', import.meta.url));
const password = 'hosted-restart-test-password';
const folderPrefix = 'sports-sync-hosted-restart-';

const upstreamFixture = String.raw`
globalThis.fetch = async (input, init = {}) => {
  if (process.env.HOSTED_RESTART_FORBID_UPLOADS === '1') throw new Error('Persisted receipt should prevent any upstream request');
  const url = new URL(input);
  const authorization = new Headers(init.headers).get('authorization') || '';
  const credential = Buffer.from(authorization.replace(/^Basic /, ''), 'base64').toString('utf8');
  const user = { 'API_KEY:restart-alice': 'alice', 'API_KEY:restart-bob': 'bob' }[credential];
  if (url.origin !== 'https://intervals.icu' || !user) throw new Error('Unexpected upstream request');
  const id = 'fixture-' + user;
  if (url.pathname === '/api/v1/athlete/0/activities' && init.method === 'POST') {
    return Response.json({ activities: [{ id }] }, { status: 201 });
  }
  if (url.pathname === '/api/v1/activity/' + id && init.method === 'GET') return Response.json({ id });
  throw new Error('Unexpected Intervals.icu request');
};
`;

async function freePort() {
  const listener = createServer();
  const ready = once(listener, 'listening');
  listener.listen(0, '127.0.0.1');
  await ready;
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const ended = await Promise.race([exited.then(() => true), wait(2000, false, { ref: false })]);
  if (!ended) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function waitForHealth(origin, child, status, diagnostics) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response) {
      await response.arrayBuffer();
      if (response.status === status) return;
    }
    await wait(50);
  }
  assert.fail('Hosted service did not report health ' + status + ': ' + diagnostics());
}

function client(origin) {
  let cookie;
  return async (path, { body, bytes, status = 200 } = {}) => {
    const headers = new Headers(cookie ? { Cookie: cookie } : {});
    const write = body !== undefined || bytes !== undefined;
    if (write) {
      headers.set('Origin', origin);
      headers.set('Content-Type', bytes ? 'application/octet-stream' : 'application/json');
    }
    const response = await fetch(origin + path, { headers, method: write ? 'POST' : 'GET',
      body: bytes ?? (write ? JSON.stringify(body) : undefined), signal: AbortSignal.timeout(5000) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';', 1)[0];
    const contents = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, status, path);
    return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(contents) : contents;
  };
}

async function runJob(request, jobId) {
  const started = await request('/api/run', { body: { jobId } });
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await request('/api/workspace');
    if (state.run?.id === started.id && state.run.status !== 'running') return state;
    await wait(20);
  }
  assert.fail('Hosted sync did not finish');
}

test('hosted CLI preserves two users, jobs, confirmed records and files across process restart', { timeout: 30_000 }, async t => {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, folderPrefix));
  let child;
  t.after(async () => {
    await stop(child);
    if (dirname(directory) === parent && basename(directory).startsWith(folderPrefix)) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  const keyPath = join(directory, 'vault.key');
  const fixturePath = join(directory, 'upstream.mjs');
  const vaultKey = randomBytes(32).toString('base64url') + '\n';
  await writeFile(keyPath, vaultKey, { mode: 0o600 });
  await writeFile(fixturePath, upstreamFixture);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, GARMIN_WEB_HOST: '127.0.0.1', GARMIN_WEB_PORT: String(port), GARMIN_WEB_ORIGIN: origin,
    GARMIN_WEB_DATA_DIR: join(directory, 'data'), GARMIN_WEB_VAULT_KEY_FILE: keyPath };
  delete env.GARMIN_WEB_VAULT_KEY;

  async function start(forbidUploads, health = 200) {
    child = spawn(process.execPath, ['--import', pathToFileURL(fixturePath).href, entry], {
      env: { ...env, HOSTED_RESTART_FORBID_UPLOADS: forbidUploads ? '1' : '0' }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    let diagnostics = '';
    child.on('error', error => { diagnostics += error.message; });
    child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000); });
    await waitForHealth(origin, child, health, () => diagnostics);
  }

  await start(false);
  const users = [];
  for (const name of ['alice', 'bob']) {
    const request = client(origin);
    const { stdout } = await runFile(process.execPath, [entry, 'invite'], { env, windowsHide: true, timeout: 5000 });
    const invite = new URLSearchParams(new URL(stdout.split(/\r?\n/, 1)[0]).hash.slice(1)).get('invite');
    await request('/api/auth/register', { body: { username: name, password, invite }, status: 201 });
    await request('/api/account', { body: { platform: 'intervals_icu', credential: { apiKey: 'restart-' + name } } });
    const bytes = Buffer.from(`<?xml version="1.0"?><gpx version="1.1" creator="fixture"><trk><name>${name}</name><trkseg><trkpt lat="36" lon="118"/><trkpt lat="36.01" lon="118.01"/></trkseg></trk></gpx>`);
    const { fileId } = await request('/api/files/import?name=' + name + '.gpx', { bytes });
    const job = await request('/api/jobs/save', { body: { name, source: 'local', targets: ['intervals_icu'], limit: 1, skip: 0, interval: 0 } });
    const state = await runJob(request, job.id);
    assert.equal(state.run.confirmed, 1);
    assert.equal(state.history.length, 1);
    const [receipt] = state.history;
    assert.equal(receipt.status, 'confirmed');
    assert.equal(receipt.activityId, 'fixture-' + name);
    users.push({ name, request, bytes, fileId, jobId: job.id, receipt, runId: state.run.id });
  }

  await stop(child);
  await writeFile(keyPath, randomBytes(32).toString('base64url'));
  await start(true, 503);
  await users[0].request('/api/workspace', { status: 503 });
  await stop(child);
  await writeFile(keyPath, vaultKey);
  await start(true);

  for (const [user, other] of [[users[0], users[1]], [users[1], users[0]]]) {
    const state = await user.request('/api/workspace');
    assert.equal(state.viewer.username, user.name);
    assert.equal(state.platforms.find(item => item.id === 'intervals_icu').state, 'saved');
    assert.deepEqual(state.jobs.map(job => job.id), [user.jobId]);
    assert.deepEqual(state.history, [user.receipt]);
    assert.equal(state.run.id, user.runId);
    assert.deepEqual(state.files.map(file => file.id), [user.fileId]);
    assert.deepEqual(await user.request('/api/files/' + user.fileId), user.bytes);
    await user.request('/api/files/' + other.fileId, { status: 404 });
    await user.request('/api/run', { body: { jobId: other.jobId }, status: 404 });
    await user.request('/api/login', { body: { region: 'cn' }, status: 503 });

    const relogin = client(origin);
    const account = await relogin('/api/auth/login', { body: { username: user.name, password } });
    assert.equal(account.viewer.username, user.name);
    const rerun = await runJob(relogin, user.jobId);
    assert.equal(rerun.run.status, 'finished');
    assert.equal(rerun.run.skipped, 1);
    assert.equal(rerun.run.failed, 0);
    assert.equal(rerun.run.unconfirmed, 0);
    assert.deepEqual(rerun.history, [user.receipt]);
  }
});
