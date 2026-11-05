import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, rmdir, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HostedVault } from '../hosted-vault.mjs';

const key = Buffer.alloc(32, 0x41);
const aliceEntries = { garmin: {}, credentials: { wahoo: { accessToken: 'fixture-alice-private-token' } } };
const bobEntries = { garmin: {}, credentials: { wahoo: { accessToken: 'fixture-bob-private-token' } } };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sports-sync-vault-'));
  const path = join(directory, 'credentials.enc');
  t.after(async () => {
    await rm(path, { force: true });
    await rmdir(directory);
  });
  return { directory, path };
}

test('hosted vault persists credentials atomically with random ciphertext and private permissions', async t => {
  const { directory, path } = await fixture(t);
  const vault = new HostedVault(path, key, 'alice');
  assert.deepEqual(await vault.load(), { garmin: {}, credentials: {} });
  await vault.save(aliceEntries);
  const first = await readFile(path);
  assert.equal(first.includes('fixture-alice-private-token'), false);
  assert.deepEqual(await new HostedVault(path, key, 'alice').load(), aliceEntries);
  await vault.save(aliceEntries);
  const second = await readFile(path);
  assert.notDeepEqual(first, second);
  assert.deepEqual(await vault.load(), aliceEntries);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['credentials.enc']);
});

test('wrong key, wrong user, tampered data, and invalid input leave existing contents intact', async t => {
  const { path } = await fixture(t);
  const vault = new HostedVault(path, key, 'alice');
  await vault.save(aliceEntries);
  const original = await readFile(path);
  for (const wrong of [new HostedVault(path, key, 'bob'), new HostedVault(path, Buffer.alloc(32), 'alice')]) {
    await assert.rejects(wrong.load(), { status: 503, code: 'corrupt' });
    await assert.rejects(wrong.save(bobEntries), { status: 503, code: 'corrupt' });
    assert.deepEqual(await readFile(path), original);
  }
  await assert.rejects(vault.save({ garmin: {}, credentials: [] }), { status: 503, code: 'input' });
  assert.deepEqual(await readFile(path), original);
  const tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 0xff;
  await writeFile(path, tampered);
  await assert.rejects(vault.load(), { status: 503, code: 'corrupt' });
  await assert.rejects(vault.save(aliceEntries), { status: 503, code: 'corrupt' });
  assert.deepEqual(await readFile(path), tampered);
});

test('concurrent first saves under different user IDs cannot replace one another', async t => {
  const { path } = await fixture(t);
  const vaults = [new HostedVault(path, key, 'alice'), new HostedVault(path, key, 'bob')];
  const entries = [aliceEntries, bobEntries];
  const results = await Promise.allSettled(vaults.map((vault, index) => vault.save(entries[index])));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  assert.equal(results[1 - winner].reason.code, 'corrupt');
  assert.deepEqual(await vaults[winner].load(), entries[winner]);
  await assert.rejects(vaults[1 - winner].load(), { status: 503, code: 'corrupt' });
});

test('oversized envelopes are rejected and cannot be overwritten by save', async t => {
  const { path } = await fixture(t);
  const vault = new HostedVault(path, key, 'alice');
  const oversized = 17 * 1024 * 1024;
  await writeFile(path, Buffer.alloc(0));
  await truncate(path, oversized);
  await assert.rejects(vault.load(), { status: 503, code: 'corrupt' });
  await assert.rejects(vault.save(aliceEntries), { status: 503, code: 'corrupt' });
  assert.equal((await stat(path)).size, oversized);
});
