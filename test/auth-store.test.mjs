import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthError, AuthStore } from '../auth-store.mjs';

const password = 'a-test-password-01';

test('an invitation creates exactly one account across competing SQLite connections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sports-sync-auth-'));
  const path = join(dir, 'auth.sqlite');
  const first = new AuthStore(path);
  const second = new AuthStore(path);
  t.after(async () => {
    first.close();
    second.close();
    await Promise.all(['', '-wal', '-shm'].map(suffix => rm(path + suffix, { force: true })));
    await rmdir(dir);
  });
  const { token: invite } = first.createInvite();
  const results = await Promise.allSettled([
    first.register({ username: ' Alice ', password, invite }),
    second.register({ username: 'Bob', password, invite }),
  ]);
  const accepted = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof AuthError);
  assert.equal(rejected[0].reason.status, 400);
  const user = accepted[0].value;
  assert.match(user.username, /^(alice|bob)$/);
  assert.deepEqual(second.listUsers(), [user]);
  await assert.rejects(first.register({ username: 'Chris', password, invite }), { status: 400 });
});

test('username collisions leave the new invitation available to a different user', async t => {
  const store = new AuthStore();
  t.after(() => store.close());
  await store.register({ username: 'Alice', password, invite: store.createInvite().token });
  const { token: invite } = store.createInvite();
  await assert.rejects(store.register({ username: ' ALICE ', password, invite }), { status: 409 });
  const bob = await store.register({ username: 'Bob', password, invite });
  assert.equal(bob.username, 'bob');
});

test('login normalizes the name, and logout and expiry invalidate session tokens', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
  const store = new AuthStore();
  t.after(() => store.close());
  const { token: expired, expiresAt } = store.createInvite({ ttlMs: 1000 });
  t.mock.timers.setTime(expiresAt);
  await assert.rejects(store.register({ username: 'Alice', password, invite: expired }), { status: 400 });
  const user = await store.register({ username: 'Alice', password, invite: store.createInvite().token });
  const wrong = { status: 401, message: '用户名或密码不正确。' };
  await assert.rejects(store.login({ username: 'Alice', password: 'a-wrong-password' }), wrong);
  await assert.rejects(store.login({ username: 'Unknown', password: 'a-wrong-password' }), wrong);

  const session = await store.login({ username: ' ALICE ', password });
  assert.deepEqual(session.user, user);
  assert.deepEqual(store.getSession(session.token), user);
  store.revokeSession(session.token);
  assert.equal(store.getSession(session.token), null);

  const next = store.createSession(user.id);
  assert.notEqual(next.token, session.token);
  t.mock.timers.setTime(next.expiresAt);
  assert.equal(store.getSession(next.token), null);
});
