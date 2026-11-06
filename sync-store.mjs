import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const protectedStatus = `(
  json_extract(payload, '$.status') IN ('sending','accepted','unconfirmed','confirmed','duplicate','guided')
  OR (json_extract(payload, '$.status')='released' AND json_extract(payload, '$.previousStatus') IN ('confirmed','duplicate'))
)`;

function parseReceipt(row) {
  if (!row) return undefined;
  const receipt = JSON.parse(row.payload);
  // Versions that allowed releasing a confirmed receipt still recorded its original outcome.
  if (receipt.status === 'released' && ['confirmed', 'duplicate'].includes(receipt.previousStatus)) {
    receipt.status = receipt.previousStatus;
    receipt.message = '历史回执已恢复防重传保护。';
  }
  return receipt;
}

export function digest(...values) {
  const hash = createHash('sha256');
  for (const value of values) hash.update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).update('\0');
  return hash.digest('hex');
}

export class SyncStore {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, updated TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS receipt_route ON receipts (json_extract(payload, '$.source'),
        json_extract(payload, '$.sourceId'), json_extract(payload, '$.target'));
      CREATE INDEX IF NOT EXISTS receipt_file ON receipts (json_extract(payload, '$.fileId'), json_extract(payload, '$.target'));
      CREATE INDEX IF NOT EXISTS receipt_target_activity ON receipts (json_extract(payload, '$.target'), json_extract(payload, '$.activityId'));
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, created TEXT NOT NULL, payload TEXT NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS ride_exploration (
        file_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (file_id, version)
      );
      CREATE TABLE IF NOT EXISTS last_run (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workout_receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    `);
  }

  jobs() {
    return this.db.prepare('SELECT payload FROM jobs ORDER BY rowid').all().map(row => JSON.parse(row.payload));
  }

  saveJob(job) {
    this.db.prepare('INSERT INTO jobs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(job.id, JSON.stringify(job));
  }

  deleteJob(id) {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  receipt(id) {
    const row = this.db.prepare('SELECT payload FROM receipts WHERE id = ?').get(id);
    return parseReceipt(row);
  }

  protectedReceipt(source, sourceId, target, id, unstable) {
    const row = this.db.prepare(`SELECT payload FROM receipts
      WHERE json_extract(payload, '$.source')=? AND json_extract(payload, '$.sourceId')=?
        AND json_extract(payload, '$.target')=? AND id<>?
        AND (?=1 OR json_extract(payload, '$.unstableIdentity')=1)
        AND ${protectedStatus}
      ORDER BY updated DESC LIMIT 1`).get(source, sourceId, target, id, unstable ? 1 : 0);
    return parseReceipt(row);
  }

  protectedFileReceipt(fileId, target, targetScope, unstableTarget) {
    const row = this.db.prepare(`SELECT payload FROM receipts
      WHERE json_extract(payload, '$.fileId')=? AND json_extract(payload, '$.target')=?
        AND (json_extract(payload, '$.targetScope')=? OR json_extract(payload, '$.targetScope') IS NULL
          OR ?=1 OR json_extract(payload, '$.unstableTarget')=1)
        AND ${protectedStatus}
      ORDER BY updated DESC LIMIT 1`).get(fileId, target, targetScope, unstableTarget ? 1 : 0);
    return parseReceipt(row);
  }

  importedFrom(source, sourceId, sourceAccount, target, targetAccount) {
    const rows = this.db.prepare(`SELECT id,payload FROM receipts
      WHERE json_extract(payload, '$.target')=? AND json_extract(payload, '$.activityId')=?
        AND json_extract(payload, '$.source')=? AND ${protectedStatus}`).all(source, sourceId, target);
    return rows.some(row => {
      const receipt = parseReceipt(row);
      return receipt.status === 'confirmed' && row.id === digest(target, targetAccount, receipt.sourceId, source, sourceAccount);
    });
  }

  saveReceipt(id, receipt) {
    const updated = new Date().toISOString();
    this.db.prepare('INSERT INTO receipts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,payload=excluded.payload')
      .run(id, updated, JSON.stringify({ ...receipt, id, updated }));
  }

  history() {
    return this.db.prepare('SELECT payload FROM receipts ORDER BY updated DESC LIMIT 100').all().map(row => {
      const { targetScope, unstableTarget, ...visible } = parseReceipt(row);
      return visible;
    });
  }

  lastRun() {
    const row = this.db.prepare('SELECT payload FROM last_run WHERE id=1').get();
    return row ? JSON.parse(row.payload) : null;
  }

  saveRun(run) {
    this.db.prepare('INSERT OR REPLACE INTO last_run VALUES (1, ?)').run(JSON.stringify(run));
  }

  workoutReceipt(id) {
    const row = this.db.prepare('SELECT payload FROM workout_receipts WHERE id=?').get(id);
    return row ? JSON.parse(row.payload) : null;
  }

  saveWorkoutReceipt(id, receipt) {
    this.db.prepare('INSERT OR REPLACE INTO workout_receipts VALUES (?, ?)').run(id, JSON.stringify(receipt));
  }

  archive(file, activity = {}) {
    const id = digest(file.data);
    const created = new Date().toISOString();
    const metadata = {
      id, created, fileName: file.fileName, name: activity.name || file.fileName,
      type: activity.type || 'unknown', time: activity.time || created,
      distance: activity.distance ?? null, duration: activity.duration ?? null, size: file.data.length,
      coordinateSystem: file.coordinateSystem,
    };
    this.db.prepare('INSERT OR IGNORE INTO files VALUES (?, ?, ?, ?)').run(id, created, JSON.stringify(metadata), file.data);
    return id;
  }

  files(start = 0, limit = 20) {
    return this.db.prepare('SELECT payload FROM files ORDER BY created DESC, id DESC LIMIT ? OFFSET ?')
      .all(limit, start).map(row => JSON.parse(row.payload));
  }

  unindexedRideFiles(version) {
    return this.db.prepare(`SELECT files.id FROM files LEFT JOIN ride_exploration
      ON ride_exploration.file_id = files.id AND ride_exploration.version = ?
      WHERE ride_exploration.file_id IS NULL ORDER BY files.rowid`).all(version).map(row => row.id);
  }

  rideExploration(id, version) {
    const row = this.db.prepare('SELECT payload FROM ride_exploration WHERE file_id = ? AND version = ?').get(id, version);
    return row ? JSON.parse(row.payload) : null;
  }

  saveRideExploration(id, version, entry) {
    this.db.prepare('INSERT OR IGNORE INTO ride_exploration (file_id, version, payload) VALUES (?, ?, ?)')
      .run(id, version, JSON.stringify(entry));
  }

  rideExplorationInArchiveOrder(version) {
    return this.db.prepare(`SELECT files.id, ride_exploration.payload FROM files JOIN ride_exploration
      ON ride_exploration.file_id = files.id AND ride_exploration.version = ? ORDER BY files.rowid`).all(version);
  }

  trackLibraryPage(start, limit) {
    const { total } = this.db.prepare('SELECT COUNT(*) AS total FROM files').get();
    const files = this.db.prepare(`SELECT payload FROM files
      ORDER BY CASE WHEN json_extract(payload, '$.time') <> created THEN julianday(json_extract(payload, '$.time')) END DESC,
        created DESC, id DESC LIMIT ? OFFSET ?`).all(limit, start).map(row => JSON.parse(row.payload));
    return { files, total };
  }

  file(id) {
    const row = this.db.prepare('SELECT payload, data FROM files WHERE id = ?').get(id);
    if (!row) return null;
    return { ...JSON.parse(row.payload), data: Buffer.from(row.data) };
  }

  close() { this.db.close(); }
}
