import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Encoder, Profile } from '@garmin/fitsdk';
import { createMultiUserServer } from '../multi-user-server.mjs';
import { createWorkspaceHandler } from '../server.mjs';
import { SyncStore } from '../sync-store.mjs';

test('track library pages the owner archive and reads only visible summaries', async t => {
  const alice = new SyncStore(), bob = new SyncStore();
  const encoder = new Encoder();
  const startTime = new Date('2026-11-04T00:00:00Z');
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1 });
  encoder.onMesg(Profile.MesgNum.SESSION, { startTime, sport: 'cycling', totalTimerTime: 1800, totalDistance: 15000,
    totalAscent: 245, enhancedAvgSpeed: 8.4, avgHeartRate: 145, avgPower: 200 });
  const newest = alice.archive({ fileName: 'indoor.fit', data: Buffer.from(encoder.close()) }, { time: '2026-11-05T00:00:00Z' });
  for (let day = 1; day <= 23; day++) {
    alice.archive({ fileName: `october-${day}.fit`, data: Buffer.from(`invalid FIT ${day}`) },
      { time: new Date(Date.UTC(2026, 9, day)).toISOString() });
  }
  const undated = alice.archive({ fileName: 'undated.fit', data: Buffer.from('undated') });
  const bobFile = bob.archive({ fileName: 'bob.fit', data: Buffer.from('bob') });
  const readFile = alice.file.bind(alice);
  const reads = [];
  alice.file = id => { reads.push(id); return readFile(id); };

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
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (id, query = '') => fetch(`${origin}/api/track-library${query}`,
    { headers: id ? { Cookie: `sports_sync_session=${id}` } : {} });
  assert.equal((await request()).status, 401);
  assert.equal((await request('alice', '?start=-1')).status, 400);
  assert.equal((await request('alice', '?start=0&start=20')).status, 400);

  const first = await (await request('alice')).json();
  assert.equal(first.total, 25);
  assert.equal(first.nextStart, 20);
  assert.equal(first.files.length, 20);
  assert.equal(first.files[0].id, newest);
  assert.equal(first.files[0].startTime, startTime.toISOString());
  assert.equal(first.files[0].metrics.avgPowerW, 200);
  assert.equal(first.files[0].metrics.avgHeartRateBpm, 145);
  assert.equal(first.files[0].metrics.avgSpeedMps, 8.4);
  assert.equal(first.files[0].metrics.ascentM, 245);
  assert.equal(first.files[0].metrics.durationSeconds, 1800);
  assert.equal(first.files[0].metrics.distanceM, 15000);
  assert.equal(first.files[1].startTime, '2026-10-23T00:00:00.000Z');
  assert.equal(first.files[1].metrics, null);
  assert.deepEqual(reads, first.files.map(file => file.id));
  assert.deepEqual(await (await request('alice')).json(), first);
  assert.equal(reads.length, 20);

  const last = await (await request('alice', '?start=20')).json();
  assert.equal(last.nextStart, null);
  assert.equal(last.files.length, 5);
  assert.deepEqual(last.files.at(-1), { id: undated, name: 'undated.fit', fileName: 'undated.fit',
    startTime: null, metrics: null, estimated: [] });
  assert.equal(new Set([...first.files, ...last.files].map(file => file.id)).size, 25);
  assert.equal(reads.length, 25);
  const other = await (await request('bob')).json();
  assert.equal(other.total, 1);
  assert.deepEqual(other.files.map(file => file.id), [bobFile]);
});
