import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStore } from '../auth-store.mjs';
import { createMultiUserServer } from '../multi-user-server.mjs';

const password = 'personal-test-password';

test('simultaneous setup requests on separate database connections create one persistent owner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sports-sync-personal-auth-'));
  const path = join(dir, 'auth.sqlite');
  const first = new AuthStore(path);
  const second = new AuthStore(path);
  t.after(async () => {
    first.close();
    second.close();
    await Promise.all(['', '-wal', '-shm'].map(suffix => rm(path + suffix, { force: true })));
    await rmdir(dir);
  });

  const results = await Promise.allSettled([
    first.setupOwner({ username: 'Alice', password }),
    second.setupOwner({ username: 'Bob', password }),
  ]);
  const owners = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const refusals = results.filter(result => result.status === 'rejected');
  assert.equal(owners.length, 1);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].reason.status, 409);

  const reopened = new AuthStore(path);
  try {
    assert.equal(reopened.setupRequired(), false);
    assert.deepEqual(reopened.listUsers(), owners);
    assert.deepEqual((await reopened.login({ username: owners[0].username, password })).user, owners[0]);
  } finally {
    reopened.close();
  }
});

test('personal HTTP setup uses the permitted device, signs in once, and disables invites', async t => {
  const authStore = new AuthStore();
  let allowNetwork = false;
  let allowSetup = false;
  const server = createMultiUserServer({
    authStore,
    personal: true,
    network: {
      allows: address => allowNetwork && address === '127.0.0.1',
      checkSetup: address => allowSetup && address === '127.0.0.1',
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    authStore.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const setup = '/api/auth/setup';
  const credentials = { username: ' Alice ', password };
  const forwarded = { 'X-Forwarded-For': '192.168.50.10' };
  function post(path, data, headers) {
    return fetch(origin + path, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(data),
    });
  }

  assert.equal((await fetch(origin + '/healthz', { headers: forwarded })).status, 403);
  allowNetwork = true;
  assert.equal((await fetch(origin + setup, { headers: forwarded })).status, 403);
  assert.equal((await post(setup, credentials, forwarded)).status, 403);
  allowSetup = true;

  assert.deepEqual(await (await fetch(origin + setup)).json(), { required: true });
  assert.equal((await post(setup, credentials, { Origin: 'https://example.test' })).status, 403);
  assert.equal((await post(setup, { ...credentials, password: 'short' })).status, 400);
  const invite = authStore.createInvite().token;
  assert.equal((await post('/api/auth/register', { ...credentials, invite })).status, 404);

  const initialized = await post(setup, credentials);
  assert.equal(initialized.status, 201);
  assert.deepEqual(await initialized.json(), { viewer: { username: 'alice' } });
  const cookie = initialized.headers.get('set-cookie').split(';')[0];
  const session = await fetch(origin + '/api/auth/session', { headers: { Cookie: cookie } });
  assert.deepEqual(await session.json(), { viewer: { username: 'alice' } });

  allowSetup = false;
  assert.deepEqual(await (await fetch(origin + setup)).json(), { required: false });
  assert.equal((await post(setup, { ...credentials, username: 'Bob' })).status, 409);
  assert.equal((await post('/api/auth/login', credentials)).status, 200);
  assert.equal(authStore.listUsers().length, 1);
});
