import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { SessionVault, SessionVaultError } from '../session-vault.mjs';

async function directory(t) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'sports-vault-test-'));
  t.after(async () => {
    assert.equal(dirname(root), parent);
    assert.ok(basename(root).startsWith('sports-vault-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function fakeSpawn(handler) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const input = [];
    child.stdout = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', -1)); return true; };
    child.stdin = new Writable({
      write(chunk, _encoding, done) { input.push(chunk); done(); },
      final(done) {
        done();
        queueMicrotask(() => {
          const result = handler({ executable, args, options, input: Buffer.concat(input).toString('ascii') });
          if (result === null) return;
          if (result instanceof Error) { child.emit('error', result); return; }
          child.stdout.end(result.output || '');
          child.emit('close', result.code || 0);
        });
      },
    });
    return child;
  };
}
const synthetic = { igpsport: { token: 'synthetic-private-token' }, xingzhe: { sessionId: 'synthetic-session', name: '中文 🚴' } };
const opaque = Buffer.from('opaque-test-only-ciphertext').toString('base64');

test('missing vault is empty without spawning PowerShell', async t => {
  const root = await directory(t);
  const vault = new SessionVault(join(root, 'new', 'sessions.json'), { platform: 'win32', spawnImpl: () => assert.fail('no cipher to decrypt') });
  assert.deepEqual(await vault.load(), {});
  assert.deepEqual(await readdir(root), []);
});

test('secrets use stdin only, current-user DPAPI command is static, disk contains ciphertext', async t => {
  const root = await directory(t);
  const path = join(root, 'nested', 'sessions.json');
  const calls = [];
  const spawnImpl = fakeSpawn(call => {
    calls.push(call);
    const command = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
    assert.match(command, /DataProtectionScope\]::CurrentUser/);
    assert.ok(!command.includes('LocalMachine'));
    assert.ok(!call.args.join(' ').includes('synthetic-private-token'));
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'ignore']);
    if (command.includes('::Protect(')) {
      assert.deepEqual(JSON.parse(Buffer.from(call.input, 'base64')), synthetic);
      return { output: opaque };
    }
    assert.equal(call.input, opaque);
    return { output: Buffer.from(JSON.stringify(synthetic)).toString('base64') };
  });
  const vault = new SessionVault(path, { platform: 'win32', spawnImpl });
  await vault.save(synthetic);
  const disk = await readFile(path, 'utf8');
  assert.ok(!disk.includes('synthetic-private-token'));
  assert.equal(JSON.parse(disk).protection, 'windows-dpapi-current-user');
  assert.deepEqual(await vault.load(), synthetic);
  assert.equal(calls.length, 2);
  assert.deepEqual(await readdir(dirname(path)), ['sessions.json']);
});

test('unsupported OS has no plaintext or alternate protection fallback', async t => {
  const root = await directory(t);
  const vault = new SessionVault(join(root, 'sessions.json'), { platform: 'linux', spawnImpl: () => assert.fail('must not spawn') });
  for (const operation of [() => vault.load(), () => vault.save(synthetic)]) {
    await assert.rejects(operation(), error => error instanceof SessionVaultError && error.code === 'unavailable');
  }
  assert.deepEqual(await readdir(root), []);
});

test('plaintext, malformed and unknown envelopes are rejected without any decrypt attempt', async t => {
  const root = await directory(t);
  const path = join(root, 'sessions.json');
  const vault = new SessionVault(path, { platform: 'win32', spawnImpl: () => assert.fail('bad envelope must not decrypt') });
  for (const value of [JSON.stringify(synthetic), 'invalid', '[]', 'null', JSON.stringify({ version: 2, protection: 'windows-dpapi-current-user', ciphertext: opaque }), JSON.stringify({ version: 1, protection: 'windows-dpapi-current-user', ciphertext: 'invalid%%%' })]) {
    await writeFile(path, value);
    await assert.rejects(vault.load(), error => error.code === 'corrupt' && !error.message.includes('synthetic'));
    assert.equal(await readFile(path, 'utf8'), value);
  }
});

test('process failure and timeout are sanitized and preserve the previous vault', async t => {
  const root = await directory(t);
  const path = join(root, 'sessions.json');
  await writeFile(path, 'previous-encrypted-file');
  for (const result of [new Error('private-token-in-system-error'), { code: 2, output: 'private-token' }, { output: 'invalid-json-and-token' }, null]) {
    const vault = new SessionVault(path, { platform: 'win32', timeoutMs: 15, spawnImpl: fakeSpawn(() => result) });
    await assert.rejects(vault.save(synthetic), error => error.code === 'unavailable' && !error.message.includes('private-token'));
    assert.equal(await readFile(path, 'utf8'), 'previous-encrypted-file');
    assert.deepEqual(await readdir(root), ['sessions.json']);
  }
});

test('invalid save input never creates a vault', async t => {
  const root = await directory(t);
  const vault = new SessionVault(join(root, 'sessions.json'), { platform: 'win32', spawnImpl: () => assert.fail('invalid input') });
  const cycle = {}; cycle.self = cycle;
  for (const value of [null, [], 'token', cycle, { token: 'x'.repeat(16 * 1024 * 1024) }]) await assert.rejects(vault.save(value), error => error.code === 'input');
  assert.deepEqual(await readdir(root), []);
});

test('atomic replace failure leaves its existing destination and no temporary file', async t => {
  const root = await directory(t);
  const path = join(root, 'sessions.json');
  await mkdir(path);
  await writeFile(join(path, 'sentinel'), 'preserve');
  const vault = new SessionVault(path, { platform: 'win32', spawnImpl: fakeSpawn(() => ({ output: opaque })) });
  await assert.rejects(vault.save(synthetic), error => error.code === 'storage');
  assert.equal(await readFile(join(path, 'sentinel'), 'utf8'), 'preserve');
  assert.deepEqual(await readdir(root), ['sessions.json']);
});

test('real Windows DPAPI persists across instances, rejects tampering, and clears disconnected entries', { skip: process.platform !== 'win32' }, async t => {
  const root = await directory(t);
  const path = join(root, 'sessions.json');
  await new SessionVault(path).save(synthetic);
  assert.deepEqual(await new SessionVault(path).load(), synthetic);
  const original = await readFile(path, 'utf8');
  assert.ok(!original.includes('synthetic-private-token'));
  const damaged = JSON.parse(original);
  const bytes = Buffer.from(damaged.ciphertext, 'base64');
  bytes[bytes.length - 1] ^= 1;
  damaged.ciphertext = bytes.toString('base64');
  await writeFile(path, JSON.stringify(damaged));
  await assert.rejects(new SessionVault(path).load(), error => error.code === 'corrupt');
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(damaged));
  await writeFile(path, original);
  await new SessionVault(path).save({});
  assert.deepEqual(await new SessionVault(path).load(), {});
});

test('queued Windows writes snapshot inputs and the final write wins', { skip: process.platform !== 'win32' }, async t => {
  const root = await directory(t);
  const vault = new SessionVault(join(root, 'sessions.json'));
  const first = { platform: { token: 'synthetic-first' } };
  const one = vault.save(first);
  first.platform.token = 'mutated-after-save';
  const two = vault.save({ platform: { token: 'synthetic-last' } });
  const loaded = vault.load();
  await Promise.all([one, two]);
  assert.deepEqual(await loaded, { platform: { token: 'synthetic-last' } });
  assert.deepEqual(await readdir(root), ['sessions.json']);
});
