import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const MAX_PLAIN = 16 * 1024 * 1024;
const MAX_ENVELOPE = 24 * 1024 * 1024;
const protection = 'windows-dpapi-current-user';
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const base64 = value => typeof value === 'string' && value.length > 0 &&
  value.length <= MAX_ENVELOPE && /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
  Buffer.from(value, 'base64').toString('base64') === value;

export class SessionVaultError extends Error {
  constructor(message, code, status = 503) {
    super(message);
    this.name = 'SessionVaultError';
    this.code = code;
    this.status = status;
  }
}

const unavailable = () => new SessionVaultError('Windows 会话保护不可用，凭据未保存。', 'unavailable');
const corrupt = () => new SessionVaultError('无法解密已保存的会话，请使用原 Windows 用户，或重新连接账号。', 'corrupt');
const storage = () => new SessionVaultError('无法读写本机会话文件，已有凭据文件未被替换。', 'storage');

// The command is static. All credential bytes travel through private process pipes,
// never command arguments, a script file, console logging, or PowerShell error text.
function script(operation) {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Security
  $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $entropy = [Text.Encoding]::UTF8.GetBytes('sports-data-sync-web/session-vault/v1')
  $result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($result))
  [Array]::Clear($bytes, 0, $bytes.Length)
  [Array]::Clear($result, 0, $result.Length)
} catch { exit 2 }
`;
}

export class SessionVault {
  #pending = Promise.resolve();
  #path;
  #platform;
  #spawn;
  #timeout;

  constructor(path, { platform = process.platform, spawnImpl = spawn, timeoutMs = 15000 } = {}) {
    if (typeof path !== 'string' || !path.trim()) throw new SessionVaultError('请指定本机会话文件。', 'input', 400);
    this.#path = resolve(path);
    this.#platform = platform;
    this.#spawn = spawnImpl;
    this.#timeout = timeoutMs;
  }

  #enqueue(action) {
    const task = this.#pending.then(action);
    this.#pending = task.catch(() => {});
    return task;
  }

  #windows() {
    if (this.#platform !== 'win32') throw unavailable();
  }

  #crypt(operation, bytes) {
    const error = operation === 'Protect' ? unavailable : corrupt;
    return new Promise((accept, reject) => {
      let child;
      let timer;
      let settled = false;
      const chunks = [];
      let size = 0;
      const finish = (failure, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const chunk of chunks) chunk.fill(0);
        if (failure) reject(failure); else accept(result);
      };
      try {
        const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        child = this.#spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(script(operation), 'utf16le').toString('base64')], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        });
        timer = setTimeout(() => { child.kill(); finish(error()); }, this.#timeout);
        child.on('error', () => finish(error()));
        child.stdin.on('error', () => finish(error()));
        child.stdout.on('error', () => finish(error()));
        child.stdout.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_ENVELOPE) { child.kill(); finish(error()); }
          else chunks.push(chunk);
        });
        child.on('close', code => {
          if (settled) return;
          const output = Buffer.concat(chunks);
          const value = output.toString('ascii');
          output.fill(0);
          if (code !== 0 || !base64(value)) return finish(error());
          finish(null, Buffer.from(value, 'base64'));
        });
        child.stdin.end(bytes.toString('base64'), 'ascii');
      } catch {
        child?.kill();
        finish(error());
      }
    });
  }

  async load() {
    return this.#enqueue(async () => {
      this.#windows();
      let file;
      try { file = await readFile(this.#path); }
      catch (error) { if (error.code === 'ENOENT') return {}; throw storage(); }
      let envelope;
      try {
        if (file.length > MAX_ENVELOPE) throw new Error();
        envelope = JSON.parse(file.toString('utf8'));
        if (envelope?.version !== 1 || envelope.protection !== protection || !base64(envelope.ciphertext)) throw new Error();
      } catch { throw corrupt(); }
      const plain = await this.#crypt('Unprotect', Buffer.from(envelope.ciphertext, 'base64'));
      try {
        if (plain.length > MAX_PLAIN) throw new Error();
        const entries = JSON.parse(plain.toString('utf8'));
        if (!plainObject(entries)) throw new Error();
        return entries;
      } catch { throw corrupt(); }
      finally { plain.fill(0); }
    });
  }

  async save(entries) {
    this.#windows();
    let plain;
    try {
      if (!plainObject(entries)) throw new Error();
      plain = Buffer.from(JSON.stringify(entries), 'utf8');
      if (plain.length > MAX_PLAIN || !plainObject(JSON.parse(plain.toString('utf8')))) throw new Error();
    } catch {
      plain?.fill(0);
      throw new SessionVaultError('会话内容格式不正确或过大，凭据未保存。', 'input', 400);
    }
    return this.#enqueue(async () => {
      let encrypted;
      try { encrypted = await this.#crypt('Protect', plain); }
      finally { plain.fill(0); }
      const envelope = JSON.stringify({ version: 1, protection, ciphertext: encrypted.toString('base64') });
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      let handle;
      try {
        await mkdir(dirname(this.#path), { recursive: true });
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(envelope, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, this.#path);
      } catch { throw storage(); }
      finally {
        await handle?.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
    });
  }
}
