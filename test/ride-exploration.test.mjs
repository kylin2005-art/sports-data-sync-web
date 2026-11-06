import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Encoder, Profile } from '@garmin/fitsdk';
import { createMultiUserServer } from '../multi-user-server.mjs';
import { createWorkspaceHandler } from '../server.mjs';
import { SyncStore } from '../sync-store.mjs';
import { buildRideExplorationIndex, createRideExploration, rideExplorationMonth } from '../ride-exploration.mjs';

function gpx(lons, day, fileName = 'ride.gpx') {
  const points = lons.map((lon, i) => `<trkpt lat="1" lon="${lon}">${day ?
    `<time>2026-10-${day}T10:00:0${i}Z</time>` : ''}</trkpt>`);
  return { fileName, data: Buffer.from(`<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`) };
}

function fit(lons, day, sport) {
  const encoder = new Encoder();
  const startTime = new Date(`2026-10-${day}T10:00:00Z`);
  const units = 2 ** 31 / 180;
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1 });
  lons.forEach((lon, i) => encoder.onMesg(Profile.MesgNum.RECORD, { timestamp: new Date(+startTime + i * 1000),
    positionLat: Math.round(units), positionLong: Math.round(lon * units) }));
  encoder.onMesg(Profile.MesgNum.SESSION, { startTime, sport });
  return { fileName: 'ride.fit', data: Buffer.from(encoder.close()) };
}

test('exploration compares ride chronology across FIT and GPX, using every archived file and only the owner data', async t => {
  const alice = new SyncStore(), bob = new SyncStore();
  const selected = alice.archive(gpx([0.006, 0.010, 0.0101], '03'));
  const later = alice.archive(gpx([0.010, 0.026], '04'));
  const running = alice.archive(fit([0.026, 0.028], '01', 'running'));
  const offset = alice.archive({ ...gpx([0.021, 0.023], '01'), coordinateSystem: 'GCJ-02' });
  alice.archive(gpx([0.017, 0.018], '01'), { type: 'trail_running' });
  for (let i = 0; i < 21; i++) alice.archive({ fileName: 'invalid.fit', data: Buffer.from(`invalid ${i}`) });
  const earlier = fit([0.002, 0.006], '02', 'cycling');
  const earlierId = alice.archive(earlier);
  assert.equal(alice.archive(earlier), earlierId);
  const untimed = alice.archive(gpx([0.010, 0.031], null));
  const bobId = bob.archive(gpx([0.010, 0.040], '01'));

  let reads = 0;
  const read = alice.file.bind(alice);
  alice.file = id => { reads++; return read(id); };
  const contexts = Object.fromEntries([['alice', alice], ['bob', bob]].map(([id, store]) =>
    [id, createWorkspaceHandler({}, () => ({ store, hasGarmin: () => false }))]));
  const server = createMultiUserServer({
    authStore: { getSession: id => Object.hasOwn(contexts, id) ? { id, username: id } : null },
    workspaceFor: user => contexts[user.id],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    alice.close();
    bob.close();
  });
  const fetchRide = (owner, id) => fetch(`http://127.0.0.1:${server.address().port}/api/ride/${id}/exploration`,
    { headers: owner ? { Cookie: `sports_sync_session=${owner}` } : {} });
  assert.equal((await fetchRide(null, selected)).status, 401);
  const fetchMonth = owner => fetch(`http://127.0.0.1:${server.address().port}/api/ride-exploration/month?month=2026-10`,
    { headers: owner ? { Cookie: `sports_sync_session=${owner}` } : {} });
  assert.equal((await fetchMonth(null)).status, 401);
  assert.equal((await fetchRide('bob', selected)).status, 404);
  assert.equal((await fetchRide('alice', bobId)).status, 404);
  assert.equal((await fetchRide('alice', running)).status, 422);
  assert.equal((await fetchRide('alice', offset)).status, 422);

  const result = await (await fetchRide('alice', selected)).json();
  assert.equal(result.cellMeters, 500);
  assert.equal(result.currentCells.length, 2);
  assert.equal(result.previousCells.length, 2);
  assert.deepEqual(result.newCells, [result.currentCells[1]]);
  assert.deepEqual(result.previousCells[1], result.currentCells[0]);
  const readsAfterFirst = reads;
  assert.deepEqual(await (await fetchRide('alice', selected)).json(), result);
  assert.equal(reads, readsAfterFirst);
  assert.equal((await (await fetchRide('alice', later)).json()).previousCells.length, 3);
  assert.equal((await (await fetchRide('alice', untimed)).json()).previousCells.length, 4);

  alice.archive(gpx([0.010, 0.012], '01'));
  const recomputed = await (await fetchRide('alice', selected)).json();
  assert.equal(recomputed.previousCells.length, 3);
  assert.deepEqual(recomputed.newCells, []);
  assert.equal((await (await fetchRide('bob', bobId)).json()).previousCells.length, 0);
  assert.equal((await (await fetchMonth('alice')).json()).rideCount, 4);
  const bobMonth = await (await fetchMonth('bob')).json();
  assert.equal(bobMonth.rideCount, 1);
  assert.equal(bobMonth.highlight.id, bobId);
});

test('monthly exploration uses local month boundaries and prior months in the same year', async () => {
  const store = new SyncStore();
  try {
    function archive(lons, date) {
      const { fileName, data } = gpx(lons, '01');
      return store.archive({ fileName, data: Buffer.from(data.toString().replaceAll('2026-10-01T10:', date)) });
    }
    archive([0.002, 0.006, 0.010, 0.014, 0.018], '2025-12-20T10:');
    archive([0.002, 0.006], '2026-10-12T10:');
    const boundary = archive([0.002, 0.006, 0.010], '2026-10-31T23:');
    assert.equal(archive([0.002, 0.006, 0.010], '2026-10-31T23:'), boundary);
    archive([0.006, 0.0101, 0.0102], '2026-11-02T10:');
    archive([0.002, 0.006, 0.010, 0.014, 0.018], '2026-12-20T10:');
    store.archive(gpx([0.018, 0.022], null));
    await buildRideExplorationIndex(store);
    store.file = () => { throw new Error('monthly report read a source file'); };

    const china = await rideExplorationMonth(store, '2026-11', 'Asia/Shanghai');
    assert.equal(china.rideCount, 2);
    assert.equal(china.highlight.id, boundary);
    assert.equal(china.highlight.cells, 3);
    assert.equal(china.previousBest, 2);
    assert.deepEqual(china.heatCells.map(cell => cell[2]), [1, 2, 2]);

    const utc = await rideExplorationMonth(store, '2026-11', 'UTC');
    assert.equal(utc.rideCount, 1);
    assert.equal(utc.previousBest, 3);
    assert.deepEqual(utc.heatCells.map(cell => cell[2]), [1, 1]);
    assert.equal((await rideExplorationMonth(store, '2026-01')).highlight, null);
    await assert.rejects(rideExplorationMonth(store, '2026-13'), { status: 400 });
    await assert.rejects(rideExplorationMonth(store, '2026-11', 'Invalid/Zone'), { status: 400 });
  } finally {
    store.close();
  }
});

test('the exploration index survives reopening a legacy archive and only reads new files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ride-index-'));
  const dbPath = join(dir, 'sync.sqlite');
  let store = new SyncStore(dbPath);
  try {
    const prior = fit([0.002, 0.006], '02', 'cycling');
    const priorId = store.archive(prior);
    const selectedId = store.archive(gpx([0.006, 0.010], '03'));
    const badId = store.archive({ fileName: 'broken.fit', data: Buffer.from('invalid FIT') });
    store.db.exec('DROP TABLE ride_exploration');
    store.close();

    store = new SyncStore(dbPath);
    await buildRideExplorationIndex(store);
    const expected = await createRideExploration(store)(selectedId);
    assert.equal(expected.newCells.length, 1);
    store.close();

    store = new SyncStore(dbPath);
    const reads = [];
    const file = store.file.bind(store);
    store.file = id => { reads.push(id); return file(id); };
    const explore = createRideExploration(store);
    assert.deepEqual(await explore(selectedId), expected);
    await assert.rejects(explore(badId), { status: 422 });
    assert.equal(store.archive(prior), priorId);
    assert.deepEqual(await explore(selectedId), expected);
    assert.deepEqual(reads, []);

    const gpxId = store.archive(gpx([0.010, 0.014], '01'));
    const fitId = store.archive(fit([0.018, 0.022], '04', 'cycling'));
    const [updated, concurrent] = await Promise.all([explore(selectedId), explore(selectedId)]);
    assert.deepEqual(updated, concurrent);
    assert.deepEqual(updated.newCells, []);
    assert.deepEqual(reads, [gpxId, fitId]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
