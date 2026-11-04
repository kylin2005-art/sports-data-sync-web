import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { createServer } from '../server.mjs';
import { SyncStore } from '../sync-store.mjs';
import { SyncWorkspace } from '../sync-workspace.mjs';

const ride = { id: '123', name: '测试骑行', type: 'cycling', time: '2026-11-04T07:00:00Z', distance: 12000, duration: 1800 };
const data = Buffer.from('12345678.FITtest');
const imported = { activityId: '456', url: 'https://connect.garmin.com/modern/activity/456', message: '目标活动已回查' };
const failure = (status, message) => Object.assign(new Error(message), { status });

function fixture(store, overrides = {}) {
  const garmin = {
    verify: async region => ({ message: '已验证', accountKey: `test-${region}` }),
    activities: async () => ({ activities: [ride], nextStart: null }),
    download: async () => ({ data, fileName: 'ride.fit' }),
    upload: async (_region, file, callbacks) => {
      assert.deepEqual(file.data, data);
      await callbacks.beforeUpload();
      await callbacks.onImported(imported);
      return imported;
    },
    confirm: async (_region, id) => { assert.equal(id, imported.activityId); return imported; },
    ...overrides,
  };
  const uploads = { definitions: [{ id: 'intervals_icu', formats: ['fit'], fields: [{ key: 'apiKey', label: 'API key', required: true }] }],
    upload: async input => { await input.beforeUpload(); return { status: 'accepted', message: '等待平台处理' }; } };
  const sources = { definitions: [] };
  return { garmin, workspace: options => new SyncWorkspace({ garmin, store, uploads, sources, ...options }) };
}

async function finish(read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await read();
    if (state.run && state.run.status !== 'running') return state;
    await wait(10);
  }
  assert.fail('同步任务没有在预期时间内结束');
}

test('HTTP workspace fans out the original once and preserves different result states', async t => {
  let downloads = 0;
  let posts = 0;
  const store = new SyncStore();
  const app = fixture(store, {
    download: async () => { downloads++; return { data, fileName: 'ride.fit' }; },
    upload: async (_region, file, callbacks) => {
      await callbacks.beforeUpload(); posts++;
      assert.deepEqual(file.data, data);
      await callbacks.onImported(imported);
      return imported;
    },
  });
  const server = createServer(app.garmin, app.workspace);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.syncWorkspace.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body) {
    const result = await fetch(origin + path, body ? {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : {});
    const value = await result.json();
    assert.equal(result.status, 200, JSON.stringify(value));
    return value;
  }
  await request('/api/verify', { region: 'cn' });
  await request('/api/verify', { region: 'com' });
  await request('/api/account', { platform: 'intervals_icu', credential: { apiKey: 'test-token' } });
  await request('/api/list', { source: 'cn', start: 0 });
  const run = { source: 'cn', targets: ['com', 'intervals_icu'], ids: [ride.id] };
  await request('/api/run', run);
  const state = await finish(() => request('/api/workspace'));
  assert.equal(state.run.confirmed, 1);
  assert.equal(state.run.unconfirmed, 1);
  assert.deepEqual(state.history.map(row => row.status).sort(), ['accepted', 'confirmed']);
  assert.equal(state.files.length, 1);
  assert.ok(!JSON.stringify(state).includes('test-token'));
  const file = await fetch(`${origin}/api/files/${state.files[0].id}`);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), data);
  await request('/api/run', run);
  assert.equal((await finish(() => request('/api/workspace'))).run.skipped, 2);
  await request('/api/account', { platform: 'intervals_icu', credential: { apiKey: 'refreshed-token' } });
  await request('/api/run', run);
  const refreshed = await finish(() => request('/api/workspace'));
  assert.equal(refreshed.run.skipped, 2);
  assert.equal(refreshed.history.length, 2);
  assert.equal(downloads, 1);
  assert.equal(posts, 1);
});

test('a known pending Garmin ID survives a restart and is only read back', async () => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'sports-sync-test-'));
  const database = join(root, 'sync.sqlite');
  let workspace;
  const run = { source: 'cn', targets: ['com'], ids: [ride.id] };
  async function prepare(store, overrides) {
    workspace = fixture(store, overrides).workspace();
    workspace.setGarmin('cn', { accountKey: 'test-cn' });
    workspace.setGarmin('com', { accountKey: 'test-com' });
    await workspace.list({ source: 'cn' });
  }
  try {
    await prepare(new SyncStore(database), { upload: async (_region, _file, callbacks) => {
      await callbacks.beforeUpload();
      await callbacks.onImported(imported);
      throw failure(502, '目标尚未读回');
    } });
    workspace.start(run);
    const pending = await finish(() => workspace.state());
    assert.equal(pending.history[0].status, 'unconfirmed');
    assert.equal(pending.history[0].activityId, '456');
    await workspace.close();
    workspace = null;
    let reads = 0;
    await prepare(new SyncStore(database), {
      download: async () => { assert.fail('回查不应下载'); },
      upload: async () => { assert.fail('回查不应上传'); },
      confirm: async (region, id) => {
        assert.equal(region, 'com'); assert.equal(id, '456'); reads++;
        return imported;
      },
    });
    workspace.start(run);
    const recovered = await finish(() => workspace.state());
    assert.equal(reads, 1);
    assert.equal(recovered.run.confirmed, 1);
    assert.equal(recovered.history[0].status, 'confirmed');
  } finally {
    await workspace?.close();
    if (dirname(root) === parent && basename(root).startsWith('sports-sync-test-')) await rm(root, { recursive: true, force: true });
  }
});

test('job pagination honors the skip/count and saves its next run', async t => {
  const starts = [];
  const { workspace: create } = fixture(new SyncStore(), {
    activities: async start => {
      starts.push(start);
      return { activities: [{ ...ride, id: String(123 + start), name: `ride ${start}` }], nextStart: start < 2 ? start + 1 : null };
    },
  });
  const workspace = create();
  t.after(() => workspace.close());
  workspace.setGarmin('cn', { accountKey: 'test-cn' });
  const job = workspace.saveJob({ name: '只下载第二条', source: 'cn', targets: ['local'], limit: 1, skip: 1, interval: 15 });
  workspace.start({ jobId: job.id });
  const state = await finish(() => workspace.state());
  assert.deepEqual(starts, [0, 1]);
  assert.equal(state.history[0].sourceId, '124');
  assert.ok(state.jobs[0].lastRun);
  assert.ok(state.jobs[0].nextRun > Date.now());
});

test('a Garmin re-verification without a stable profile does not bypass prior send protection', async t => {
  let posts = 0;
  const workspace = fixture(new SyncStore(), { upload: async (_region, _file, callbacks) => {
    await callbacks.beforeUpload();
    posts++;
    throw failure(502, '目标结果暂不可知');
  } }).workspace();
  t.after(() => workspace.close());
  workspace.setGarmin('cn', {});
  workspace.setGarmin('com', { accountKey: 'test-com' });
  await workspace.list({ source: 'cn' });
  const input = { source: 'cn', targets: ['com'], ids: [ride.id] };
  workspace.start(input);
  assert.equal((await finish(() => workspace.state())).run.unconfirmed, 1);
  workspace.setGarmin('cn', { accountKey: 'test-cn' });
  await workspace.list({ source: 'cn' });
  workspace.start(input);
  assert.equal((await finish(() => workspace.state())).run.skipped, 1);
  assert.equal(posts, 1);
});

test('two separate original-file HTTP 406 responses stop the batch before the next activity', async t => {
  const seen = [];
  const rides = ['123', '124', '125'].map(id => ({ ...ride, id }));
  const workspace = fixture(new SyncStore(), {
    activities: async () => ({ activities: rides, nextStart: null }),
    download: async (_region, id) => {
      seen.push(id);
      throw Object.assign(failure(502, '原始文件下载：HTTP 406'), { upstreamStatus: 406 });
    },
  }).workspace();
  t.after(() => workspace.close());
  workspace.setGarmin('cn', { accountKey: 'test-cn' });
  await workspace.list({ source: 'cn' });
  workspace.start({ source: 'cn', targets: ['local'], ids: rides.map(item => item.id) });
  const state = await finish(() => workspace.state());
  assert.deepEqual(seen, ['123', '124']);
  assert.equal(state.run.failed, 2);
  assert.equal(state.run.status, 'stopped');
  assert.equal(state.files.length, 0);
});

test('a confirmed original file is not uploaded again from the local library or by releasing the receipt', async t => {
  let posts = 0;
  const store = new SyncStore();
  const workspace = fixture(store, { upload: async (_region, _file, callbacks) => {
    await callbacks.beforeUpload();
    posts++;
    await callbacks.onImported(imported);
    return imported;
  } }).workspace();
  t.after(() => workspace.close());
  workspace.setGarmin('cn', { accountKey: 'test-cn' });
  workspace.setGarmin('com', { accountKey: 'test-com' });
  await workspace.list({ source: 'cn' });
  workspace.start({ source: 'cn', targets: ['com'], ids: [ride.id] });
  const initial = await finish(() => workspace.state());
  assert.equal(initial.run.confirmed, 1);
  assert.throws(() => workspace.release({ id: initial.history[0].id }), { status: 409 });
  const historical = store.receipt(initial.history[0].id);
  store.saveReceipt(historical.id, { ...historical, status: 'released', previousStatus: 'confirmed' });
  const { fileId } = workspace.importFile({ data, fileName: 'renamed.fit' });
  await workspace.list({ source: 'local' });
  workspace.start({ source: 'local', targets: ['com'], ids: [fileId] });
  assert.equal((await finish(() => workspace.state())).run.skipped, 1);
  assert.equal(posts, 1);
  workspace.setGarmin('com', { accountKey: 'different-test-com' });
  workspace.start({ source: 'local', targets: ['com'], ids: [fileId] });
  assert.equal((await finish(() => workspace.state())).run.confirmed, 1);
  assert.equal(posts, 2);
});
