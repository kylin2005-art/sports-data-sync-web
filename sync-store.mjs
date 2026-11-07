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
      CREATE TABLE IF NOT EXISTS ride_highlights (
        file_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (file_id, version)
      );
      CREATE TABLE IF NOT EXISTS ride_reports (
        file_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (file_id, version)
      );
      CREATE TABLE IF NOT EXISTS ride_journal (file_id TEXT PRIMARY KEY NOT NULL, updated TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS track_summaries (
        file_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, start_ms INTEGER, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS track_summary_time ON track_summaries(version, start_ms);
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

  fileNameForExploration(id) {
    return this.db.prepare("SELECT json_extract(payload, '$.name') AS name FROM files WHERE id = ?").get(id)?.name;
  }

  rideJournal() {
    return this.db.prepare(`SELECT ride_journal.payload FROM ride_journal JOIN files ON files.id = ride_journal.file_id
      ORDER BY ride_journal.updated DESC, ride_journal.file_id`).all().map(row => JSON.parse(row.payload));
  }

  hasRideJournalEntry(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM ride_journal WHERE file_id = ?').get(id));
  }

  saveRideJournalEntry(id, entry) {
    this.db.prepare(`INSERT INTO ride_journal (file_id, updated, payload) VALUES (?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET updated = excluded.updated, payload = excluded.payload`)
      .run(id, new Date().toISOString(), JSON.stringify({ id, ...entry }));
  }

  removeRideJournalEntry(id) {
    this.db.prepare('DELETE FROM ride_journal WHERE file_id = ?').run(id);
  }

  unindexedRideHighlightFiles(version) {
    return this.db.prepare(`SELECT files.id FROM files LEFT JOIN ride_highlights
      ON ride_highlights.file_id = files.id AND ride_highlights.version = ?
      WHERE ride_highlights.file_id IS NULL ORDER BY files.rowid`).all(version).map(row => row.id);
  }

  saveRideHighlights(version, entries) {
    const write = this.db.prepare('INSERT OR IGNORE INTO ride_highlights (file_id, version, payload) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const [id, entry] of entries) write.run(id, version, JSON.stringify(entry));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  rideHighlightRows(version) {
    return this.db.prepare(`SELECT files.id, json_extract(files.payload, '$.name') AS name, ride_highlights.payload
      FROM ride_highlights JOIN files ON files.id = ride_highlights.file_id WHERE ride_highlights.version = ?`).all(version);
  }

  unindexedRideReportFiles(version) {
    return this.db.prepare(`SELECT files.id FROM files LEFT JOIN ride_reports
      ON ride_reports.file_id = files.id AND ride_reports.version = ?
      WHERE ride_reports.file_id IS NULL ORDER BY files.rowid`).all(version).map(row => row.id);
  }

  saveRideReport(id, version, entry) {
    this.db.prepare('INSERT OR IGNORE INTO ride_reports VALUES (?, ?, ?)').run(id, version, JSON.stringify(entry));
  }

  rideReportRows(version) {
    return this.db.prepare(`SELECT files.id, json_extract(files.payload, '$.name') AS name, ride_reports.payload
      FROM ride_reports JOIN files ON files.id = ride_reports.file_id
      WHERE ride_reports.version = ? AND ride_reports.payload <> 'null'`).all(version);
  }

  trackLibraryPage(start, limit) {
    const { total } = this.db.prepare('SELECT COUNT(*) AS total FROM files').get();
    const files = this.db.prepare(`SELECT payload FROM files
      ORDER BY CASE WHEN json_extract(payload, '$.time') <> created THEN julianday(json_extract(payload, '$.time')) END DESC,
        created DESC, id DESC LIMIT ? OFFSET ?`).all(limit, start).map(row => JSON.parse(row.payload));
    return { files, total };
  }

  trackSummary(id, version) {
    const row = this.db.prepare('SELECT payload FROM track_summaries WHERE file_id = ? AND version = ?').get(id, version);
    return row ? JSON.parse(row.payload) : undefined;
  }

  unindexedTrackFiles(version) {
    return this.db.prepare(`SELECT files.id FROM files LEFT JOIN track_summaries
      ON track_summaries.file_id = files.id AND track_summaries.version = ?
      WHERE track_summaries.file_id IS NULL ORDER BY files.rowid`).all(version).map(row => row.id);
  }

  saveTrackSummaries(version, entries) {
    const write = this.db.prepare(`INSERT INTO track_summaries (file_id, version, start_ms, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET version = excluded.version, start_ms = excluded.start_ms, payload = excluded.payload
      WHERE track_summaries.version < excluded.version`);
    this.db.exec('BEGIN');
    try {
      for (const [id, summary] of entries) {
        write.run(id, version, summary.startTime ? Date.parse(summary.startTime) : null, JSON.stringify(summary));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  filteredTrackPage(version, start, limit, { from, before, ranges }) {
    const conditions = ['summary.version = ?'], values = [version];
    if (from !== null) { conditions.push('summary.start_ms >= ?'); values.push(from); }
    if (before !== null) { conditions.push('summary.start_ms < ?'); values.push(before); }
    for (const [metric, min, max] of ranges) {
      const path = '$.metrics.' + metric;
      if (min !== null) { conditions.push('json_extract(summary.payload, ?) >= ?'); values.push(path, min); }
      if (max !== null) { conditions.push('json_extract(summary.payload, ?) <= ?'); values.push(path, max); }
    }
    const match = `FROM track_summaries AS summary JOIN files ON files.id = summary.file_id
      WHERE ${conditions.join(' AND ')}`;
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total ${match}`).get(...values);
    const files = this.db.prepare(`SELECT files.payload AS file, summary.payload AS summary ${match}
      ORDER BY summary.start_ms DESC, files.created DESC, files.id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, start).map(row => ({ ...JSON.parse(row.file), ...JSON.parse(row.summary) }));
    return { files, total };
  }

  file(id) {
    const row = this.db.prepare('SELECT payload, data FROM files WHERE id = ?').get(id);
    if (!row) return null;
    return { ...JSON.parse(row.payload), data: Buffer.from(row.data) };
  }

  close() { this.db.close(); }
}
