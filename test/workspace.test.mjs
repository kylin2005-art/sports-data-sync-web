import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { validFit } from '../garmin-browser.mjs';
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

test('account sign-in preserves the existing session when provider readback fails', async t => {
  const store = new SyncStore();
  const saves = [];
  let rejectReadback = true;
  const loginFields = [{ key: 'password', label: '密码', type: 'password', required: true }];
  const workspace = fixture(store).workspace({
    sessionData: { credentials: { magene: { token: 'old-session' } } },
    sessionVault: { save: async record => saves.push(structuredClone(record)) },
    sources: {
      definitions: [{ id: 'magene', fields: [{ key: 'token', label: 'Token', required: true }] }],
      verify: async (platform, credential) => {
        assert.equal(platform, 'magene');
        assert.deepEqual(credential, { token: 'new-session' });
        if (rejectReadback) throw failure(401, '平台验证失败');
      },
    },
    platformPasswords: {
      fields: id => id === 'magene' ? loginFields : [],
      signIn: async () => ({ credential: { token: 'new-session', password: 'do-not-save' }, verified: false }),
    },
  });
  t.after(() => workspace.close());
  const input = { platform: 'magene', fields: { password: 'do-not-save' } };
  await assert.rejects(workspace.signIn(input), /平台验证失败/);
  assert.equal(saves.length, 0);
  assert.equal(workspace.state().platforms.find(item => item.id === 'magene').state, 'saved');
  rejectReadback = false;
  assert.match((await workspace.signIn(input)).message, /已通过登录验证/);
  assert.deepEqual(saves[0].credentials.magene, { token: 'new-session' });
});

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
    const replay = { id: ride.id, receiptId: pending.history[0].id, targetActivityId: imported.activityId };
    workspace.verifyGarminReplay(replay);
    assert.equal((await finish(() => workspace.state())).run.status, 'failed');
    assert.equal(reads, 0);
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

test('guarded Garmin replay uses the exact confirmed receipt for the current accounts', async t => {
  let downloads = 0;
  let uploads = 0;
  const workspace = fixture(new SyncStore(), {
    download: async () => { downloads++; return { data, fileName: 'ride.fit' }; },
    upload: async (_region, _file, callbacks) => {
      await callbacks.beforeUpload();
      uploads++;
      return imported;
    },
  }).workspace();
  t.after(() => workspace.close());
  workspace.setGarmin('cn', { accountKey: 'test-cn' });
  workspace.setGarmin('com', { accountKey: 'test-com' });
  await workspace.list({ source: 'cn' });
  workspace.start({ source: 'cn', targets: ['com'], ids: [ride.id] });
  const { history } = await finish(() => workspace.state());
  assert.equal(history[0].status, 'confirmed');
  const replay = { id: ride.id, receiptId: history[0].id, targetActivityId: imported.activityId };
  assert.throws(() => workspace.verifyGarminReplay({ ...replay, targetActivityId: null }), { status: 400 });
  async function run(input) {
    workspace.verifyGarminReplay(input);
    const state = await finish(() => workspace.state());
    assert.deepEqual(state.history, history);
    return state.run;
  }
  const matched = await run(replay);
  assert.equal(matched.status, 'finished');
  assert.equal(matched.skipped, 1);
  for (const mismatch of [{ receiptId: '0'.repeat(64) }, { targetActivityId: '789' }]) {
    const failed = await run({ ...replay, ...mismatch });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.skipped, 0);
  }
  workspace.setGarmin('com', { accountKey: 'other-com' });
  assert.equal((await run(replay)).status, 'failed');
  assert.equal(downloads, 1);
  assert.equal(uploads, 1);
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

test('full history jobs page beyond 50 records, then transfer only new and retryable records after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sports-history-'));
  const starts = [], downloads = [], uploads = [];
  const records = Array.from({ length: 61 }, (_, n) => ({ ...ride, id: String(200 - n) }));
  let workspace;
  let failFirst = true;
  t.after(async () => { await workspace?.close(); await rm(dir, { recursive: true, force: true }); });
  function open() {
    const result = fixture(new SyncStore(join(dir, 'sync.sqlite')), {
      activities: async (start, region) => {
        assert.equal(region, 'com');
        starts.push(start);
        const activities = records.slice(start, start + 20);
        return { activities, nextStart: start + 20 < records.length ? start + 20 : null };
      },
      download: async (_region, id) => {
        downloads.push(id);
        if (id === '150' && failFirst) throw failure(502, '原始文件暂不可用');
        return { data: Buffer.concat([data, Buffer.from(id)]), fileName: `${id}.fit` };
      },
      upload: async (region, file, callbacks) => {
        assert.equal(region, 'cn');
        await callbacks.beforeUpload();
        uploads.push(file.fileName);
        return imported;
      },
    }).workspace();
    for (const region of ['cn', 'com']) result.setGarmin(region, { accountKey: `test-${region}` });
    return result;
  }
  workspace = open();
  const job = workspace.saveJob({ name: '历史同步', source: 'com', targets: ['cn'], interval: 0 });
  assert.equal(job.mode, 'all');
  workspace.start({ jobId: job.id });
  let state = await finish(() => workspace.state());
  assert.deepEqual(starts, [0, 20, 40, 60]);
  assert.equal(state.run.confirmed, 60);
  assert.equal(state.run.failed, 1);
  assert.equal(downloads.length, 61);
  assert.ok(state.jobs[0].historyScannedAt);
  const firstScan = state.jobs[0].historyScannedAt;
  await workspace.close();
  failFirst = false;
  starts.length = downloads.length = uploads.length = 0;
  records.unshift({ ...ride, id: '201' });
  records.push({ ...ride, id: '139', time: '2020-01-01T00:00:00Z' });
  workspace = open();
  workspace.start({ jobId: job.id });
  state = await finish(() => workspace.state());
  assert.equal(state.jobs[0].historyScannedAt, firstScan);
  assert.equal(state.run.confirmed, 3);
  assert.equal(state.run.skipped, 60);
  assert.equal(state.run.failed, 0);
  assert.deepEqual(downloads, ['201', '150', '139']);
  assert.deepEqual(uploads, ['201.fit', '150.fit', '139.fit']);
});

test('cycling history scans every page, skips other and unknown sports, and deduplicates reruns', async t => {
  const starts = [], downloads = [], uploads = [];
  const cyclingTypes = ['cycling', 'road_biking', 'mountain_biking', 'indoor_cycling', 'gravel_cycling',
    'e_bike_fitness', 'e_bike_mountain', 'VirtualRide', 'cyclocross'];
  const cycling = Array.from({ length: 25 }, (_, n) => ({ ...ride, id: String(200 + n), type: cyclingTypes[n % cyclingTypes.length] }));
  const records = [...cycling.slice(0, 18), { ...ride, id: '330', type: 'trail_running' }, { ...ride, id: '331', type: 'unknown' },
    cycling[0], ...cycling.slice(18), { ...ride, id: '332', type: '17' }];
  const workspace = fixture(new SyncStore(), {
    activities: async (start, region) => {
      assert.equal(region, 'cn');
      starts.push(start);
      const activities = records.slice(start, start + 20);
      return { activities, nextStart: start + 20 < records.length ? start + 20 : null };
    },
    download: async (_region, id) => {
      downloads.push(id);
      return { data: Buffer.concat([data, Buffer.from(id)]), fileName: `${id}.fit` };
    },
    upload: async (region, file, callbacks) => {
      assert.equal(region, 'com');
      await callbacks.beforeUpload();
      uploads.push(file.fileName);
      return imported;
    },
  }).workspace();
  t.after(() => workspace.close());
  for (const region of ['cn', 'com']) workspace.setGarmin(region, { accountKey: `test-${region}` });
  const job = workspace.saveJob({ name: '骑行历史', source: 'cn', targets: ['com'], mode: 'all', activityType: 'cycling', interval: 0 });
  assert.equal(job.activityType, 'cycling');

  workspace.start({ jobId: job.id });
  let { run, history } = await finish(() => workspace.state());
  assert.deepEqual(starts, [0, 20]);
  assert.deepEqual(downloads, cycling.map(item => item.id));
  assert.deepEqual(uploads, cycling.map(item => `${item.id}.fit`));
  assert.deepEqual({ scanned: run.scanned, matched: run.matched, unclassified: run.unclassified }, { scanned: 28, matched: 25, unclassified: 2 });
  assert.equal(run.confirmed, 25);
  assert.equal(history.length, 25);
  assert.match(run.logs.at(-1).message, /跳过运动类型未识别的 2 条/);

  records.push({ ...ride, id: '333', type: 'bmx' });
  starts.length = downloads.length = uploads.length = 0;
  workspace.start({ jobId: job.id });
  ({ run, history } = await finish(() => workspace.state()));
  assert.deepEqual(starts, [0, 20]);
  assert.deepEqual(downloads, ['333']);
  assert.deepEqual(uploads, ['333.fit']);
  assert.equal(run.scanned, 29);
  assert.equal(run.matched, 26);
  assert.equal(run.skipped, 25);
  assert.equal(run.confirmed, 1);
  assert.equal(history.length, 26);
  assert.equal(workspace.saveJob({ ...job, activityType: 'all' }).historyScannedAt, null);
});

test('cycling history requires actual sport metadata from multisport adapters', async t => {
  const sources = new Map([
    ['zwift', [{ ...ride, id: '1' }, { ...ride, id: '2', sport: 'CYCLING' }, { ...ride, id: '3', sport: 'RUNNING' }]],
    ['mywhoosh', [{ ...ride, id: '1' }]],
    ['bryton', [{ ...ride, id: '1' }]],
    ['coros_cn', [{ ...ride, id: '1', type: 'unknown', sportCode: 200 },
      { ...ride, id: '2', type: 'unknown', sportCode: 100 }, { ...ride, id: '3', type: 'unknown', sportCode: 999 }]],
  ]);
  const downloads = [];
  const workspace = fixture(new SyncStore()).workspace({
    sources: {
      definitions: [...sources.keys()].map(id => ({ id, fields: [{ key: 'token', label: 'Token', required: true }] })),
      activities: async platform => ({ activities: sources.get(platform), nextStart: null }),
      download: async (platform, _credential, id) => {
        downloads.push(`${platform}:${id}`);
        return { data: Buffer.concat([data, Buffer.from(`${platform}:${id}`)]), fileName: `${platform}-${id}.fit` };
      },
    },
  });
  t.after(() => workspace.close());
  for (const source of sources.keys()) {
    await workspace.configure({ platform: source, credential: { token: 'fixture-token' } });
    const job = workspace.saveJob({ name: source, source, targets: ['local'], mode: 'all', activityType: 'cycling', interval: 0 });
    workspace.start({ jobId: job.id });
    const { run } = await finish(() => workspace.state());
    assert.equal(run.scanned, sources.get(source).length);
    assert.equal(run.unclassified, 1);
  }
  assert.deepEqual(downloads, ['zwift:2', 'coros_cn:1']);
});

test('Keep guided import produces a downloadable FIT without an upload, account, or success receipt', async t => {
  const gpx = Buffer.from(`<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
    <trkpt lat="35.1" lon="118.1"><time>2026-11-04T07:00:00Z</time></trkpt>
    <trkpt lat="35.101" lon="118.101"><time>2026-11-04T07:01:00Z</time></trkpt>
    </trkseg></trk></gpx>`);
  let downloads = 0;
  const workspace = fixture(new SyncStore(), {
    download: async () => { downloads++; return { data: gpx, fileName: 'ride.gpx' }; },
  }).workspace({ uploads: { definitions: [], upload: async () => assert.fail('Keep must never upload') } });
  t.after(() => workspace.close());
  workspace.setGarmin('cn', { accountKey: 'test-cn' });
  await workspace.list({ source: 'cn' });
  const input = { source: 'cn', targets: ['keep'], ids: [ride.id] };
  workspace.start(input);
  const state = await finish(() => workspace.state());
  assert.equal(state.run.guided, 1);
  assert.equal(state.run.confirmed, 0);
  assert.equal(state.history[0].status, 'guided');
  const exported = await workspace.guidedFit(state.history[0].id);
  assert.equal(exported.fileName, 'ride.fit');
  assert.ok(validFit(exported.data));
  assert.equal(state.files.length, 1, 'generated FIT must not enter scheduled local-file sources');
  workspace.start(input);
  assert.equal((await finish(() => workspace.state())).run.skipped, 1);
  assert.equal(downloads, 1);
});

test('a confirmed Garmin import does not bounce back to its original region', async t => {
  let downloads = 0, uploads = 0;
  const workspace = fixture(new SyncStore(), {
    activities: async (_start, region) => ({ activities: [region === 'cn' ? ride : { ...ride, id: imported.activityId }], nextStart: null }),
    download: async () => { downloads++; return { data, fileName: 'ride.fit' }; },
    upload: async (_region, _file, { beforeUpload }) => { await beforeUpload(); uploads++; return imported; },
  }).workspace();
  t.after(() => workspace.close());
  for (const region of ['cn', 'com']) workspace.setGarmin(region, { accountKey: `test-${region}` });
  await workspace.list({ source: 'cn' });
  workspace.start({ source: 'cn', targets: ['com'], ids: [ride.id] });
  assert.equal((await finish(() => workspace.state())).run.confirmed, 1);
  const job = workspace.saveJob({ name: '反向同步', source: 'com', targets: ['cn'], interval: 0 });
  workspace.start({ jobId: job.id });
  assert.equal((await finish(() => workspace.state())).run.skipped, 1);
  assert.equal(downloads, 1);
  assert.equal(uploads, 1);
});

test('workout publication has its own persistent receipt and cannot replay an uncertain write', async t => {
  let writes = 0;
  const store = new SyncStore();
  const field = key => [{ key, label: key, required: true }];
  const workspace = fixture(store).workspace({
    uploads: { definitions: [{ id: 'igpsport', formats: ['fit'], fields: field('token') },
      { id: 'intervals_icu', formats: ['fit'], fields: field('apiKey') }] },
    workouts: { publish: async ({ credential, apiKey, beforeUpload, onImported }) => {
      assert.equal(credential.token, 'target-session');
      assert.equal(apiKey, 'source-key');
      await beforeUpload();
      writes++;
      await onImported({ workoutId: '57' });
      throw Object.assign(failure(502, '读回暂不可用'), { mayHaveUploaded: true });
    } },
  });
  t.after(() => workspace.close());
  await workspace.configure({ platform: 'igpsport', credential: { token: 'target-session' } });
  await workspace.configure({ platform: 'intervals_icu', credential: { apiKey: 'source-key' } });
  const request = { platform: 'igpsport', id: '1044', oldest: '2026-11-05', newest: '2026-11-08' };
  assert.equal((await workspace.publishWorkout(request)).status, 'unconfirmed');
  assert.equal((await workspace.publishWorkout(request)).workoutId, '57');
  assert.equal(writes, 1);
  assert.deepEqual(store.history(), []);
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
