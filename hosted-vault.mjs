import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SessionVaultError } from './session-vault.mjs';

const magic = Buffer.from([0x53, 0x44, 0x53, 0x56, 1]);
const nonceSize = 12;
const tagSize = 16;
const headerSize = magic.length + nonceSize + tagSize;
const maxPlain = 16 * 1024 * 1024;
const maxEnvelope = headerSize + maxPlain;
const cipherName = 'aes-256-gcm';
const cipherOptions = { authTagLength: tagSize };
const plainObject = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validEntries = entries => plainObject(entries) && plainObject(entries.garmin) && plainObject(entries.credentials);
const invalidConfig = () => new SessionVaultError('凭据加密配置无效，请检查服务配置。', 'unavailable');
const corrupt = () => new SessionVaultError('无法解密此工作台的凭据，请检查密钥和凭据文件。', 'corrupt');
const storage = () => new SessionVaultError('无法读写此工作台的凭据，已有文件未被替换。', 'storage');
const invalidInput = () => new SessionVaultError('凭据内容格式不正确或过大，凭据未保存。', 'input');

export class HostedVault {
  #path;
  #key;
  #aad;
  #pending = Promise.resolve();

  constructor(path, keyBuffer, userId) {
    if (typeof path !== 'string' || !path.trim() || !Buffer.isBuffer(keyBuffer) || keyBuffer.length !== 32 ||
        typeof userId !== 'string' || !userId.trim() || !userId.isWellFormed() || Buffer.byteLength(userId) > 128) {
      throw invalidConfig();
    }
    this.#path = resolve(path);
    this.#key = Buffer.from(keyBuffer);
    this.#aad = Buffer.from('sports-data-sync-web/hosted-vault/v1\0' + userId, 'utf8');
  }

  #enqueue(action) {
    const task = this.#pending.then(action);
    this.#pending = task.catch(() => {});
    return task;
  }

  #decrypt(file) {
    if (!file.subarray(0, magic.length).equals(magic)) throw corrupt();
    const tagOffset = magic.length + nonceSize;
    let partial;
    let plain;
    try {
      const decipher = createDecipheriv(cipherName, this.#key, file.subarray(magic.length, tagOffset), cipherOptions);
      decipher.setAAD(this.#aad);
      decipher.setAuthTag(file.subarray(tagOffset, headerSize));
      partial = decipher.update(file.subarray(headerSize));
      plain = Buffer.concat([partial, decipher.final()]);
      const entries = JSON.parse(plain.toString('utf8'));
      if (!validEntries(entries)) throw corrupt();
      return entries;
    } catch {
      throw corrupt();
    } finally {
      partial?.fill(0);
      plain?.fill(0);
    }
  }

  async #read() {
    let handle;
    try { handle = await open(this.#path, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw storage(); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= headerSize || stat.size > maxEnvelope) throw corrupt();
      const file = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < file.length) {
        const { bytesRead } = await handle.read(file, offset, file.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) throw corrupt();
      return this.#decrypt(file.subarray(0, offset));
    } catch (error) {
      if (error instanceof SessionVaultError) throw error;
      throw storage();
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async load() {
    return this.#enqueue(async () => (await this.#read()) ?? { garmin: {}, credentials: {} });
  }

  async save(entries) {
    let plain;
    try {
      if (!validEntries(entries)) throw invalidInput();
      plain = Buffer.from(JSON.stringify(entries), 'utf8');
      if (plain.length > maxPlain || !validEntries(JSON.parse(plain.toString('utf8')))) throw invalidInput();
    } catch {
      plain?.fill(0);
      throw invalidInput();
    }

    return this.#enqueue(async () => {
      let envelope;
      let exists;
      try {
        exists = (await this.#read()) !== null;
        const nonce = randomBytes(nonceSize);
        const cipher = createCipheriv(cipherName, this.#key, nonce, cipherOptions);
        cipher.setAAD(this.#aad);
        const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
        envelope = Buffer.concat([magic, nonce, cipher.getAuthTag(), ciphertext]);
      } catch (error) {
        if (error instanceof SessionVaultError) throw error;
        throw storage();
      } finally {
        plain.fill(0);
      }
      await this.#write(envelope, exists);
    });
  }

  async #write(envelope, exists) {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    let handle;
    try {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(envelope);
      await handle.sync();
      await handle.close();
      handle = null;
      if (!exists) {
        // Publish without replacement if another process created the vault first.
        try { await link(temporary, this.#path); return; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (await this.#read() === null) throw storage();
      }
      await rename(temporary, this.#path);
    } catch (error) {
      if (error instanceof SessionVaultError) throw error;
      throw storage();
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
}
