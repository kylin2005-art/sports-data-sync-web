import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Encoder, Profile } from '@garmin/fitsdk';
import { createMultiUserServer } from '../multi-user-server.mjs';
import { monthlyRideReport } from '../ride-report.mjs';
import { createWorkspaceHandler } from '../server.mjs';
import { SyncStore } from '../sync-store.mjs';

const route = Array.from({ length: 17 }, (_, index) => 118 + index * 0.0015);

function fit(date, { route: lons = route, timer = 800, elapsed = 900, heart = 150, power = 180, sport = 'cycling', distance = 2400 } = {}) {
  const startTime = new Date(date);
  const encoder = new Encoder();
  const units = 2 ** 31 / 180;
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1 });
  lons.forEach((lon, i) => encoder.onMesg(Profile.MesgNum.RECORD, {
    timestamp: new Date(+startTime + i * 10_000), positionLat: Math.round(35 * units), positionLong: Math.round(lon * units),
  }));
  encoder.onMesg(Profile.MesgNum.SESSION, { startTime, sport, totalTimerTime: timer ?? undefined,
    totalElapsedTime: elapsed, totalDistance: distance, totalAscent: 50, avgHeartRate: heart ?? undefined, avgPower: power ?? undefined });
  return { fileName: 'ride.fit', data: Buffer.from(encoder.close()) };
}

function gpx(date, lons = route) {
  const points = lons.map((lon, index) => `<trkpt lat="35" lon="${lon}"><ele>${100 + index * 3}</ele><time>${new Date(Date.parse(date) + index * 15000).toISOString()}</time></trkpt>`);
  return { fileName: 'ride.gpx', data: Buffer.from(`<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`) };
}

test('monthly report uses the whole archive, local dates, cycling eligibility and equivalent route timing', async t => {
  const store = new SyncStore();
  t.after(() => store.close());
  store.archive(fit('2026-09-04T07:00:00Z', { timer: 700 }));
  const baseline = store.archive(fit('2026-10-30T08:00:00Z', { timer: 1000 }), { name: '基准' });
  store.archive(fit('2026-10-31T09:00:00Z', { timer: 650, route: [...route].reverse() }));
  const ride = store.archive(fit('2026-10-31T18:00:00Z', { timer: 880, heart: 145, power: 190 }), { name: '对照' });
  assert.equal(store.archive(fit('2026-10-31T18:00:00Z', { timer: 880, heart: 145, power: 190 })), ride);
  store.archive(gpx('2026-11-02T09:00:00Z')); // Same route, different timing convention.
  store.archive(gpx('2026-11-02T12:00:00Z', route.map(lon => lon + 1)), { type: 'running' });
  store.archive(fit('2026-11-03T10:00:00Z', { sport: 'running' }));
  store.archive(fit('2026-11-03T09:00:00Z', { route: route.map(lon => lon + 0.03) }));
  for (let index = 1; index <= 21; index++) {
    store.archive(fit(`2026-11-${String(index).padStart(2, '0')}T05:00:00Z`, { route: [], power: null, heart: null }));
  }

  const report = await monthlyRideReport(store, '2026-11', 'Asia/Shanghai');
  assert.equal(report.current.rideCount, 24);
  assert.equal(report.current.rideDays, 21);
  assert.equal(report.current.elapsedSeconds, 240);
  assert.equal(report.current.timerSeconds, 880 + 22 * 800);
  assert.equal(report.current.estimatedAscent, true);
  assert.equal(report.current.estimatedDistance, true);
  assert.equal(report.previousMonth, '2026-10');
  assert.equal(report.previous.rideCount, 2);
  assert.equal(report.previous.distanceM, 4800);
  assert.equal(report.matchedCount, 1);
  assert.equal(report.fasterCount, 1);
  assert.ok(report.newCells > 0);
  assert.deepEqual(report.comparisons.map(({ baseline: before, ride: after, secondsSaved, heartRateDelta, powerDelta }) =>
    [before.id, after.id, secondsSaved, heartRateDelta, powerDelta]), [[baseline, ride, 120, -5, 10]]);
  assert.equal((await monthlyRideReport(store, '2026-11')).current.rideCount, 23);
  assert.equal((await monthlyRideReport(store, '2026-01')).previousMonth, '2025-12');
  await assert.rejects(monthlyRideReport(store, '2026-13'), { status: 400 });
  await assert.rejects(monthlyRideReport(store, '2026-11', 'Invalid/Zone'), { status: 400 });
});

test('monthly report persists across restart, incrementally indexes new files, and omits missing sensors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ride-report-'));
  const path = join(directory, 'archive.sqlite');
  let store = new SyncStore(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const original = store.archive(fit('2026-10-31T10:00:00Z'));
  store.archive({ fileName: 'invalid.fit', data: Buffer.from('invalid') });
  const initial = await monthlyRideReport(store, '2026-10');
  store.close();
  store = new SyncStore(path);
  const read = store.file.bind(store), reads = [];
  store.file = id => { reads.push(id); return read(id); };
  assert.deepEqual(await monthlyRideReport(store, '2026-10'), initial);
  assert.deepEqual(reads, []);
  const added = store.archive(fit('2026-11-03T10:00:00Z', { timer: 700, heart: null, power: null }));
  const [updated, concurrent] = await Promise.all([monthlyRideReport(store, '2026-11'), monthlyRideReport(store, '2026-11')]);
  assert.deepEqual(updated, concurrent);
  assert.deepEqual([...new Set(reads)], [added]);
  assert.equal(updated.comparisons[0].baseline.id, original);
  assert.equal(updated.comparisons[0].heartRateDelta, null);
  assert.equal(updated.comparisons[0].powerDelta, null);
  assert.equal(updated.newCells, 0);
});

test('monthly report requires a session and reads only the current workspace', async t => {
  const contexts = new Map();
  for (const id of ['alice', 'bob']) {
    const store = new SyncStore();
    store.archive(fit('2026-11-04T10:00:00Z', { distance: id === 'alice' ? 2400 : 12000 }), { name: id });
    contexts.set(id, createWorkspaceHandler({}, () => ({ store, hasGarmin: () => false })));
  }
  const server = createMultiUserServer({
    authStore: { getSession: id => contexts.has(id) ? { id, username: id } : null },
    workspaceFor: user => contexts.get(user.id),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const context of contexts.values()) context.workspace.store.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/api/ride-report/month?month=2026-11`;
  assert.equal((await fetch(url)).status, 401);
  for (const id of contexts.keys()) {
    const response = await fetch(url, { headers: { Cookie: `sports_sync_session=${id}` } });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.current.rideCount, 1);
    assert.equal(report.current.longest.name, id);
    assert.equal(Object.hasOwn(report, 'mapSegments'), false);
  }
});
