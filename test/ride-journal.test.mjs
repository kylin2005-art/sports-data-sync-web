import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMultiUserServer } from '../multi-user-server.mjs';
import { createWorkspaceHandler } from '../server.mjs';
import { SyncStore } from '../sync-store.mjs';

test('route journals persist per workspace and removing a favorite preserves the activity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ride-journal-'));
  const path = join(directory, 'owner.sqlite');
  const alice = new SyncStore(path), bob = new SyncStore();
  const route = { fileName: 'loop.gpx', data: Buffer.from(`<gpx xmlns="http://www.topografix.com/GPX/1/1">
    <trk><trkseg><trkpt lat="35" lon="118"/><trkpt lat="35.01" lon="118.01"/></trkseg></trk></gpx>`) };
  const id = alice.archive(route);
  const privateId = alice.archive({ ...route, data: Buffer.concat([route.data, Buffer.from('\n')]) });
  assert.equal(bob.archive(route), id);
  const contexts = Object.fromEntries([['alice', alice], ['bob', bob]].map(([user, store]) =>
    [user, createWorkspaceHandler({}, () => ({ store, busy: true, hasGarmin: () => false }))]));
  const server = createMultiUserServer({
    authStore: { getSession: user => Object.hasOwn(contexts, user) ? { id: user, username: user } : null },
    workspaceFor: user => contexts[user.id],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    alice.close();
    bob.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (user, body, { remove = false, requestOrigin = origin } = {}) => fetch(
    `${origin}/api/ride-journal${remove ? '/remove' : ''}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(user && { Cookie: `sports_sync_session=${user}` }),
        ...(body && { Origin: requestOrigin, 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const journal = { id, title: '河边环线', tags: ['夜骑', ' 夜骑 ', '适合带新手'], water: '公园饮水机', road: '桥下碎石\n雨天易滑' };
  assert.equal((await request(null)).status, 401);
  assert.equal((await request('alice', journal, { requestOrigin: 'https://example.com' })).status, 403);
  assert.equal((await request('bob', { ...journal, id: privateId })).status, 404);
  assert.equal((await request('alice', { ...journal, tags: ['过长'.repeat(13)] })).status, 400);
  const created = await request('alice', journal);
  assert.equal(created.status, 200);
  assert.deepEqual((await created.json()).entries, [{ ...journal, tags: ['夜骑', '适合带新手'] }]);
  assert.deepEqual((await (await request('bob')).json()).entries, []);

  const edited = { ...journal, title: '周末环线', tags: ['风景好'], water: '东门补水', road: '' };
  assert.deepEqual((await (await request('alice', edited)).json()).entries, [edited]);
  const reopened = new SyncStore(path);
  try { assert.deepEqual(reopened.rideJournal(), [edited]); }
  finally { reopened.close(); }

  assert.deepEqual((await (await request('alice', { id }, { remove: true })).json()).entries, []);
  assert.deepEqual(alice.file(id).data, route.data);
});
