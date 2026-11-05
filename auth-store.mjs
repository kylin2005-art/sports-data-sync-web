import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const keyBytes = 64;
const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const dummySalt = Buffer.alloc(16);
const dummyHash = Buffer.alloc(keyBytes);
const dayMs = 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

function normalizeUsername(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(name) ? name.toLowerCase() : null;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value) <= 256 &&
    value.isWellFormed() && [...value].length >= 12;
}

function accountName(username, password) {
  const name = normalizeUsername(username);
  if (!name) throw new AuthError(400, '用户名须为 3–32 位，使用字母、数字、下划线或连字符，并以字母或数字开头。');
  if (!validPassword(password)) throw new AuthError(400, '密码至少 12 个字符，最多 256 字节。');
  return name;
}

async function newAccount(name, password) {
  const salt = randomBytes(16);
  const hash = await deriveKey(password, salt, keyBytes, scryptOptions);
  return { user: { id: randomUUID(), username: name }, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function newToken() {
  return randomBytes(32).toString('base64url');
}

function tokenHash(token) {
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}

export class AuthStore {
  #db;

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL, password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitations (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  createInvite({ ttlMs = dayMs } = {}) {
    const now = Date.now();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(now + ttlMs)) {
      throw new AuthError(400, '邀请码有效期不正确。');
    }
    const token = newToken();
    const expiresAt = now + ttlMs;
    this.#db.prepare('DELETE FROM invitations WHERE expires_at <= ?').run(now);
    this.#db.prepare('INSERT INTO invitations VALUES (?, ?)').run(tokenHash(token), expiresAt);
    return { token, expiresAt };
  }

  async register({ username, password, invite }) {
    const name = accountName(username, password);
    const invitation = tokenHash(invite);
    const invalidInvite = () => new AuthError(400, '邀请码无效、已使用或已过期。');
    if (!invitation || !this.#db.prepare('SELECT 1 FROM invitations WHERE token_hash = ? AND expires_at > ?')
      .get(invitation, Date.now())) throw invalidInvite();

    const { user, salt, hash } = await newAccount(name, password);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const used = this.#db.prepare('DELETE FROM invitations WHERE token_hash = ? AND expires_at > ?')
        .run(invitation, Date.now());
      if (used.changes !== 1) throw invalidInvite();
      if (this.#db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) {
        throw new AuthError(409, '用户名已被使用。');
      }
      this.#db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)')
        .run(user.id, user.username, salt, hash);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return user;
  }

  setupRequired() {
    return !this.#db.prepare('SELECT 1 FROM users LIMIT 1').get();
  }

  async setupOwner({ username, password }) {
    const alreadySetup = () => new AuthError(409, '首次设置已完成，请登录工作台。');
    if (!this.setupRequired()) throw alreadySetup();
    const { user, salt, hash } = await newAccount(accountName(username, password), password);
    const created = this.#db.prepare('INSERT INTO users SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)')
      .run(user.id, user.username, salt, hash);
    if (created.changes !== 1) throw alreadySetup();
    return user;
  }

  async login({ username, password }) {
    const name = normalizeUsername(username);
    const invalidCredentials = () => new AuthError(401, '用户名或密码不正确。');
    if (!name || !validPassword(password)) throw invalidCredentials();
    const row = this.#db.prepare('SELECT id, username, password_salt, password_hash FROM users WHERE username = ?').get(name);
    const salt = row ? Buffer.from(row.password_salt, 'hex') : dummySalt;
    const expected = row ? Buffer.from(row.password_hash, 'hex') : dummyHash;
    const hash = await deriveKey(password, salt, keyBytes, scryptOptions);
    if (expected.length !== keyBytes || !timingSafeEqual(hash, expected) || !row) throw invalidCredentials();
    return { user: { id: row.id, username: row.username }, ...this.createSession(row.id) };
  }

  createSession(userId) {
    const now = Date.now();
    const token = newToken();
    const expiresAt = now + 7 * dayMs;
    this.#db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.#db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash(token), userId, expiresAt);
    return { token, expiresAt };
  }

  getSession(token) {
    const hash = tokenHash(token);
    if (!hash) return null;
    const row = this.#db.prepare(`
      SELECT users.id, users.username FROM sessions JOIN users ON sessions.user_id = users.id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(hash, Date.now());
    return row ? { id: row.id, username: row.username } : null;
  }

  revokeSession(token) {
    const hash = tokenHash(token);
    if (hash) this.#db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
  }

  listUsers() {
    return this.#db.prepare('SELECT id, username FROM users ORDER BY username').all()
      .map(({ id, username }) => ({ id, username }));
  }

  close() {
    this.#db.close();
  }
}
