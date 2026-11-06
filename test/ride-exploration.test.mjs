import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Encoder, Profile } from '@garmin/fitsdk';
import { createMultiUserServer } from '../multi-user-server.mjs';
import { createWorkspaceHandler } from '../server.mjs';
import { SyncStore } from '../sync-store.mjs';

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
});
