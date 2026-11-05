import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { AuthStore } from '../auth-store.mjs';
import { createMultiUserServer } from '../multi-user-server.mjs';
import { createWorkspaceHandler } from '../server.mjs';
import { SyncStore } from '../sync-store.mjs';
import { SyncWorkspace } from '../sync-workspace.mjs';

const password = 'fixture-long-password';
const sharedActivityId = '123';
const source = 'igpsport';
const target = 'intervals_icu';
const route = { source, targets: ['local', target], ids: [sharedActivityId] };
const jobFields = { name: '每天同步', source, targets: [target], limit: 20, skip: 0, interval: 0 };
const fileBytes = name => Buffer.from('12345678.FIT-private-' + name);

function gate() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}

async function fixture(t) {
  const authStore = new AuthStore();
  const scopes = new Map();
  const actions = [];
  const aliceDownloadEntered = gate();
  const aliceDownload = gate();
  const garmin = Object.fromEntries(['openLogin', 'verify', 'activities', 'download', 'upload'].map(method => [
    method, async () => {
      actions.push({ kind: 'unexpected-garmin', method });
      throw new Error('Hosted mode must not call Garmin browsers');
    },
  ]));
  const server = createMultiUserServer({
    authStore,
    workspaceFor(user) {
      if (scopes.has(user.id)) return scopes.get(user.id);
      const { username } = user;
      const store = new SyncStore();
      const handler = createWorkspaceHandler(garmin, options => new SyncWorkspace({
        ...options,
        garmin,
        store,
        sources: {
          definitions: [{ id: source, fields: [{ key: 'token', label: 'Token', required: true }] }],
          async activities(_id, credential) {
            actions.push({ kind: 'list', username, secret: credential.token });
            return {
              activities: [{
                id: sharedActivityId, name: '活动-' + username, type: 'cycling',
                time: '2026-11-05T00:00:00Z', distance: 25000, duration: 3600,
              }],
              nextStart: null,
            };
          },
          async download(_id, credential, id) {
            actions.push({ kind: 'download', username, secret: credential.token, id });
            if (username === 'alice') {
              aliceDownloadEntered.open();
              await aliceDownload.promise;
            }
            return { data: fileBytes(username), fileName: username + '.fit' };
          },
        },
        uploads: {
          definitions: [{ id: target, formats: ['fit'], fields: [{ key: 'apiKey', label: 'API key', required: true }] }],
          async upload({ credential, data, beforeUpload }) {
            await beforeUpload();
            actions.push({ kind: 'upload', username, secret: credential.apiKey, data: Buffer.from(data) });
            return { status: 'accepted', message: '已接收，等待确认' };
          },
        },
      }));
      scopes.set(user.id, handler);
      return handler;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    aliceDownload.open();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all([...scopes.values()].map(handler => handler.workspace.close()));
    authStore.close();
  });
  const origin = 'http://127.0.0.1:' + server.address().port;

  function client() {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(path, body, options = {}) {
        const method = body === undefined ? 'GET' : 'POST';
        const headers = {};
        const requestCookie = options.cookie ?? cookie;
        if (requestCookie) headers.Cookie = requestCookie;
        if (method === 'POST') {
          headers['Content-Type'] = 'application/json';
          if (options.origin !== null) headers.Origin = options.origin ?? origin;
        }
        const response = await fetch(origin + path, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) {
          const pair = setCookie.split(';')[0];
          cookie = pair.endsWith('=') ? '' : pair;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const json = response.headers.get('content-type')?.includes('application/json')
          ? JSON.parse(bytes.toString('utf8')) : undefined;
        return { status: response.status, ok: response.ok, json, bytes, setCookie };
      },
    };
  }

  return { client, authStore, scopes, actions, aliceDownloadEntered, aliceDownload };
}

function expectStatus(result, status) {
  assert.equal(result.status, status, JSON.stringify(result.json));
  return result.json;
}

async function state(client) {
  return expectStatus(await client.request('/api/workspace'), 200);
}

async function finished(client) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await state(client);
    if (current.run && current.run.status !== 'running') return current;
    await wait(10);
  }
  assert.fail('mock sync did not finish');
}

test('invite accounts isolate sessions, platform credentials, activities, jobs, files, receipts and running sync', { timeout: 15_000 }, async t => {
  const { client, authStore, scopes, actions, aliceDownloadEntered, aliceDownload } = await fixture(t);
  const anon = client();
  const alice = client();
  const bob = client();

  expectStatus(await anon.request('/api/auth/session'), 401);
  expectStatus(await anon.request('/api/workspace'), 401);
  expectStatus(await anon.request('/api/run', route), 401);
  expectStatus(await anon.request('/api/files/' + '1'.repeat(64)), 401);
  assert.equal(scopes.size, 0);

  const aliceInvite = authStore.createInvite().token;
  const bobInvite = authStore.createInvite().token;
  for (const [user, username, invite] of [[alice, 'alice', aliceInvite], [bob, 'bob', bobInvite]]) {
    const registration = await user.request('/api/auth/register', { username, password, invite });
    expectStatus(registration, 201);
    assert.equal(registration.json.viewer.username, username);
    assert.match(registration.setCookie, /;\s*HttpOnly(?:;|$)/i);
    assert.match(registration.setCookie, /;\s*SameSite=(Strict|Lax)(?:;|$)/i);
    assert.equal(expectStatus(await user.request('/api/auth/session'), 200).viewer.username, username);
  }
  assert.notEqual(alice.cookie, bob.cookie);
  const reused = await anon.request('/api/auth/register', { username: 'carol', password, invite: aliceInvite });
  assert.equal(reused.ok, false);
  assert.equal(anon.cookie, '');
  assert.deepEqual(authStore.listUsers().map(user => user.username).sort(), ['alice', 'bob']);

  for (const path of ['/api/login', '/api/verify', '/api/account/open']) {
    const denied = await alice.request(path, { region: 'cn', platform: source });
    expectStatus(denied, 503);
  }
  assert.equal((await alice.request('/garmin')).ok, false);
  assert.deepEqual(actions, []);

  const initialBob = await state(bob);
  assert.equal(initialBob.viewer.username, 'bob');
  assert.equal(initialBob.platforms.find(platform => platform.id === source).state, 'disconnected');
  expectStatus(await alice.request('/api/account', { platform: source, credential: { token: 'source-alice' } }, { origin: null }), 403);

  async function configure(user, username) {
    expectStatus(await user.request('/api/account', { platform: source, credential: { token: 'source-' + username } }), 200);
    expectStatus(await user.request('/api/account', { platform: target, credential: { apiKey: 'upload-' + username } }), 200);
  }

  await configure(alice, 'alice');
  assert.equal((await state(bob)).platforms.find(platform => platform.id === source).state, 'disconnected');
  expectStatus(await bob.request('/api/list', { source, start: 0 }), 409);
  await configure(bob, 'bob');

  const aliceJob = expectStatus(await alice.request('/api/jobs/save', { ...jobFields, name: 'Alice private job' }), 200);
  const bobJob = expectStatus(await bob.request('/api/jobs/save', { ...jobFields, name: 'Bob private job' }), 200);
  assert.deepEqual((await state(alice)).jobs.map(job => job.id), [aliceJob.id]);
  assert.deepEqual((await state(bob)).jobs.map(job => job.id), [bobJob.id]);
  expectStatus(await bob.request('/api/jobs/save', { ...jobFields, id: aliceJob.id }), 404);
  expectStatus(await bob.request('/api/run', { jobId: aliceJob.id }), 404);
  // Deleting an absent job may be idempotent. Alice's record must remain.
  await bob.request('/api/jobs/delete', { id: aliceJob.id });
  assert.deepEqual((await state(alice)).jobs.map(job => job.id), [aliceJob.id]);

  const aliceActivities = expectStatus(await alice.request('/api/list', { source, start: 0 }), 200);
  assert.equal(aliceActivities.activities[0].id, sharedActivityId);
  expectStatus(await bob.request('/api/file-test', { source, id: sharedActivityId }), 400);
  expectStatus(await bob.request('/api/run', route), 400);

  expectStatus(await alice.request('/api/run', route), 200);
  await Promise.race([aliceDownloadEntered.promise, wait(2_000, undefined, { ref: false }).then(() => assert.fail('Alice mock download did not start'))]);
  assert.equal((await state(alice)).run.status, 'running');
  expectStatus(await bob.request('/api/stop', {}), 200);
  assert.equal((await state(alice)).run.stopRequested, false);

  const bobActivities = expectStatus(await bob.request('/api/list', { source, start: 0 }), 200);
  assert.equal(bobActivities.activities[0].id, sharedActivityId);
  assert.equal(bobActivities.activities[0].name, '活动-bob');
  expectStatus(await bob.request('/api/run', route), 200);
  const bobResult = await finished(bob);
  assert.equal(bobResult.run.confirmed, 1);
  assert.equal(bobResult.run.unconfirmed, 1);
  assert.equal((await state(alice)).run.status, 'running');
  aliceDownload.open();

  const aliceResult = await finished(alice);
  assert.equal(aliceResult.run.status, 'finished');
  assert.equal(aliceResult.run.confirmed, 1);
  assert.equal(aliceResult.run.unconfirmed, 1);
  for (const [user, other, ownResult, otherResult, username] of [
    [alice, bob, aliceResult, bobResult, 'alice'], [bob, alice, bobResult, aliceResult, 'bob'],
  ]) {
    assert.deepEqual(ownResult.files.map(file => file.fileName), [username + '.fit']);
    assert.ok(ownResult.history.every(receipt => receipt.name === '活动-' + username));
    assert.equal(JSON.stringify(ownResult).includes('source-' + username), false);
    assert.equal(JSON.stringify(ownResult).includes('upload-' + username), false);
    const file = ownResult.files[0];
    const receipt = ownResult.history.find(row => row.target === target);
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.sourceId, sharedActivityId);
    const download = await user.request('/api/files/' + file.id);
    expectStatus(download, 200);
    assert.deepEqual(download.bytes, fileBytes(username));
    expectStatus(await other.request('/api/files/' + file.id), 404);
    expectStatus(await user.request('/api/files/' + otherResult.files[0].id), 404);
    expectStatus(await other.request('/api/history/release', { id: receipt.id }), 409);
    assert.equal((await state(user)).history.find(row => row.id === receipt.id).status, 'accepted');
  }
  assert.deepEqual(actions.filter(item => item.kind === 'list').map(item => item.secret).sort(), ['source-alice', 'source-bob']);
  assert.deepEqual(actions.filter(item => item.kind === 'download').map(item => item.secret).sort(), ['source-alice', 'source-bob']);
  assert.deepEqual(actions.filter(item => item.kind === 'upload').map(item => item.secret).sort(), ['upload-alice', 'upload-bob']);
  for (const action of actions.filter(item => item.kind === 'upload')) {
    assert.deepEqual(action.data, fileBytes(action.username));
  }

  expectStatus(await bob.request('/api/disconnect', { platform: source }), 200);
  assert.equal((await state(bob)).platforms.find(platform => platform.id === source).state, 'disconnected');
  assert.equal((await state(alice)).platforms.find(platform => platform.id === source).state, 'configured');
  const revokedCookie = alice.cookie;
  expectStatus(await alice.request('/api/auth/logout', {}), 200);
  expectStatus(await alice.request('/api/workspace'), 401);
  expectStatus(await anon.request('/api/auth/session', undefined, { cookie: revokedCookie }), 401);
  assert.equal(expectStatus(await bob.request('/api/auth/session'), 200).viewer.username, 'bob');
  const login = expectStatus(await alice.request('/api/auth/login', { username: 'alice', password }), 200);
  assert.equal(login.viewer.username, 'alice');
  assert.equal((await state(alice)).history.length, 2);
  assert.equal(actions.some(item => item.kind === 'unexpected-garmin'), false);
  assert.equal(scopes.size, 2);
});
