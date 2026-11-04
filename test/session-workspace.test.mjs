import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { SyncStore, digest } from '../sync-store.mjs';
import { SyncWorkspace } from '../sync-workspace.mjs';

const ride = { id: '123', name: 'Synthetic ride', type: 'cycling', time: '2026-11-04T08:00:00Z', distance: 1000, duration: 120 };
const fit = Buffer.from('0e2000080e0000002e4649547ac9400000140001fd0486000000004098ab', 'hex');
const imported = { activityId: '456', url: 'https://connect.garmin.com/modern/activity/456', message: 'Synthetic readback confirmed' };
const privateText = /private-(?:cn|com|provider|refreshed|other)/;
const failure = (status, message, region) => Object.assign(new Error(message), { status, ...(region ? { region } : {}) });

function record(region) {
  const domain = region === 'cn' ? 'connect.garmin.cn' : 'connect.garmin.com';
  return {
    accountKey: `private-${region}-account`,
    sessionState: {
      cookies: [{ name: 'session', value: `private-${region}-cookie`, domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
      origins: [{ origin: `https://${domain}`, localStorage: [{ name: 'auth', value: `private-${region}-storage` }] }],
    },
  };
}

function savedConnections() {
  return { garmin: { cn: record('cn'), com: record('com') }, credentials: { igpsport: { token: 'private-provider-token' } } };
}

async function app(t, { sessionData, garminOverrides = {}, sourceOverrides = {}, vaultFailure = false } = {}) {
  const store = new SyncStore();
  const calls = { restore: [], forget: [], lists: [], downloads: [], uploads: [], confirms: [] };
  const vault = {
    data: structuredClone(sessionData || { garmin: {}, credentials: {} }), writes: [],
    async save(value) {
      if (vaultFailure) throw new Error('Synthetic vault write failure');
      this.data = structuredClone(value);
      this.writes.push(structuredClone(value));
    },
  };
  const garmin = {
    restore(region, value) { calls.restore.push({ region, value: structuredClone(value) }); },
    forget(region) { calls.forget.push(region); },
    openLogin: async () => ({ message: 'Synthetic login window' }),
    verify: async region => ({ message: 'Synthetic verification', ...record(region) }),
    activities: async (start, region) => { calls.lists.push({ start, region }); return { activities: [ride], nextStart: null }; },
    download: async (region, id) => { calls.downloads.push({ region, id }); return { data: fit, fileName: 'synthetic.fit' }; },
    upload: async (region, _file, callbacks) => {
      await callbacks.beforeUpload();
      calls.uploads.push(region);
      await callbacks.onImported(imported);
      return imported;
    },
    confirm: async (region, id) => { calls.confirms.push({ region, id }); return imported; },
    ...garminOverrides,
  };
  const definitions = [{ id: 'igpsport', name: 'Synthetic provider', formats: ['fit'], fields: [{ key: 'token', label: 'Token', type: 'password', required: true }] }];
  const sources = {
    definitions,
    activities: async (platform, credential, start) => {
      calls.lists.push({ platform, credential: structuredClone(credential), start });
      return { activities: [ride], nextStart: null };
    },
    download: async () => ({ data: fit, fileName: 'synthetic.fit' }),
    ...sourceOverrides,
  };
  const server = createServer(garmin, options => new SyncWorkspace({
    ...options, garmin, store, sources, uploads: { definitions, upload: async () => assert.fail('Unexpected provider upload') },
    sessionVault: vault, sessionData,
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await server.syncWorkspace.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, expectedStatus = 200) {
    const response = await fetch(origin + path, body === undefined ? {} : {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, expectedStatus, `Unexpected HTTP status for ${path}`);
    assert.doesNotMatch(text, privateText, `Private session material leaked through ${path}`);
    assert.doesNotMatch(text, /"(?:accountKey|sessionState|cookies|origins)"\s*:/, `Private session object leaked through ${path}`);
    return JSON.parse(text);
  }
  return { request, workspace: server.syncWorkspace, vault, calls, store };
}

async function finish(workspace) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!workspace.busy && workspace.state().run) return workspace.state();
    await wait(5);
  }
  assert.fail('Synthetic restored job did not finish');
}

test('saved Garmin and provider connections restore into actual HTTP state without exposing private material', async t => {
  const initial = savedConnections();
  const { request, calls, vault } = await app(t, { sessionData: initial });
  assert.deepEqual(calls.restore, [{ region: 'cn', value: initial.garmin.cn }, { region: 'com', value: initial.garmin.com }]);
  assert.deepEqual(await request('/api/state'), { cn: true, com: true });
  const state = await request('/api/workspace');
  for (const id of ['cn', 'com', 'igpsport']) assert.equal(state.platforms.find(item => item.id === id).state, 'saved');
  await request('/api/list', { source: 'igpsport', start: 0 });
  assert.deepEqual(calls.lists[0], { platform: 'igpsport', credential: initial.credentials.igpsport, start: 0 });
  assert.equal(vault.writes.length, 0, 'Restoring state should not rewrite the vault');
});

test('HTTP Garmin verification persists the private record and returns only public status', async t => {
  const { request, vault } = await app(t);
  const result = await request('/api/verify', { region: 'cn' });
  assert.equal(typeof result.message, 'string');
  assert.equal(result.accountKey, undefined);
  assert.equal(result.sessionState, undefined);
  assert.deepEqual(vault.data.garmin.cn, record('cn'));
  assert.deepEqual(await request('/api/state'), { cn: true, com: false });
  assert.equal((await request('/api/workspace')).platforms.find(item => item.id === 'cn').state, 'saved');
});

test('HTTP account configuration stores normalized fields and disconnect removes only that provider', async t => {
  const initial = savedConnections();
  const { request, vault } = await app(t, { sessionData: initial });
  await request('/api/account', { platform: 'igpsport', credential: { token: '  private-refreshed-token  ', ignored: 'not-a-supported-field' } });
  assert.deepEqual(vault.data.credentials.igpsport, { token: 'private-refreshed-token' });
  assert.deepEqual(vault.data.garmin, initial.garmin);
  await request('/api/disconnect', { platform: 'igpsport' });
  assert.equal(vault.data.credentials.igpsport, undefined);
  assert.deepEqual(vault.data.garmin, initial.garmin);
  assert.equal((await request('/api/workspace')).platforms.find(item => item.id === 'igpsport').state, 'disconnected');
  await request('/api/list', { source: 'igpsport', start: 0 }, 409);
});

test('HTTP Garmin disconnect forgets its restored session and persists removal without clearing the other region', async t => {
  const initial = savedConnections();
  const { request, vault, calls } = await app(t, { sessionData: initial });
  await request('/api/disconnect', { platform: 'cn' });
  assert.ok(calls.forget.includes('cn'));
  assert.equal(vault.data.garmin.cn, undefined);
  assert.deepEqual(vault.data.garmin.com, initial.garmin.com);
  assert.deepEqual(vault.data.credentials, initial.credentials);
  assert.deepEqual(await request('/api/state'), { cn: false, com: true });
  await request('/api/activities', { start: 0 }, 409);
});

test('401 from restored Garmin and provider reads clears only the failed saved connection', async t => {
  const initial = savedConnections();
  const { request, vault, calls } = await app(t, {
    sessionData: initial,
    garminOverrides: { activities: async () => { throw failure(401, 'Synthetic Garmin session expired', 'cn'); } },
    sourceOverrides: { activities: async () => { throw failure(401, 'Synthetic provider session expired'); } },
  });
  await request('/api/list', { source: 'cn', start: 0 }, 401);
  assert.equal(vault.data.garmin.cn, undefined);
  assert.deepEqual(vault.data.garmin.com, initial.garmin.com);
  assert.ok(calls.forget.includes('cn'));
  assert.deepEqual(await request('/api/state'), { cn: false, com: true });
  await request('/api/list', { source: 'igpsport', start: 0 }, 401);
  assert.equal(vault.data.credentials.igpsport, undefined);
  assert.deepEqual(vault.data.garmin.com, initial.garmin.com);
  await request('/api/list', { source: 'igpsport', start: 0 }, 409);
});

test('vault write failure is an HTTP failure and never reports a new saved connection', async t => {
  const { request, vault } = await app(t, { vaultFailure: true });
  await request('/api/account', { platform: 'igpsport', credential: { token: 'private-provider-token' } }, 500);
  await request('/api/verify', { region: 'cn' }, 500);
  assert.deepEqual(await request('/api/state'), { cn: false, com: false });
  const state = await request('/api/workspace');
  for (const id of ['cn', 'igpsport']) assert.equal(state.platforms.find(item => item.id === id).state, 'disconnected');
  assert.equal(vault.writes.length, 0);
});

test('restored scheduled job reuses its exact account-scoped pending receipt and confirms without reupload', async t => {
  const initial = savedConnections();
  const { workspace, store, calls, request } = await app(t, { sessionData: initial });
  const receiptKey = digest('cn', initial.garmin.cn.accountKey, ride.id, 'com', initial.garmin.com.accountKey);
  store.saveReceipt(receiptKey, { source: 'cn', sourceId: ride.id, target: 'com', name: ride.name, unstableIdentity: false,
    status: 'unconfirmed', activityId: imported.activityId, message: 'Synthetic pending confirmation' });
  store.saveJob({ id: 'synthetic-restored-job', name: 'Synthetic scheduled transfer', source: 'cn', targets: ['com'], limit: 1, skip: 0, interval: 15, nextRun: Date.now() - 1 });
  let tick;
  t.mock.method(globalThis, 'setInterval', (callback, interval) => {
    assert.equal(interval, 15000);
    tick = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  workspace.schedule();
  tick();
  const state = await finish(workspace);
  assert.equal(state.run.status, 'finished');
  assert.equal(state.run.confirmed, 1);
  assert.deepEqual(calls.confirms, [{ region: 'com', id: '456' }]);
  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.uploads.length, 0);
  assert.equal(store.history().length, 1);
  assert.equal(store.history()[0].id, receiptKey);
  assert.equal(store.receipt(receiptKey).status, 'confirmed');
  assert.ok(store.jobs()[0].nextRun > Date.now());
  await request('/api/workspace');
});

test('session refresh updates matching saved identity and refuses another account snapshot', async t => {
  const initial = savedConnections();
  const { workspace, vault, request } = await app(t, { sessionData: initial });
  const refreshed = record('cn');
  refreshed.sessionState.cookies[0].value = 'private-refreshed-cookie';
  await workspace.refreshGarminSession('cn', refreshed);
  assert.deepEqual(vault.data.garmin.cn, refreshed);
  const writes = vault.writes.length;
  await workspace.refreshGarminSession('cn', { ...record('cn'), accountKey: 'private-other-account' });
  assert.equal(vault.writes.length, writes);
  assert.deepEqual(vault.data.garmin.cn, refreshed);
  assert.deepEqual(vault.data.garmin.com, initial.garmin.com);
  await request('/api/workspace');
});
