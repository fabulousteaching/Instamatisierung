'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  match_type      TEXT    NOT NULL DEFAULT 'contains',
  keywords        TEXT    NOT NULL DEFAULT '[]',
  media_ids       TEXT    NOT NULL DEFAULT '[]',
  reply_enabled   INTEGER NOT NULL DEFAULT 1,
  reply_variants  TEXT    NOT NULL DEFAULT '[]',
  dm_enabled      INTEGER NOT NULL DEFAULT 0,
  dm_text         TEXT    NOT NULL DEFAULT '',
  dm_button_title TEXT    NOT NULL DEFAULT '',
  dm_button_url   TEXT    NOT NULL DEFAULT '',
  once_per_user   INTEGER NOT NULL DEFAULT 1,
  delay_seconds   INTEGER NOT NULL DEFAULT 10,
  priority        INTEGER NOT NULL DEFAULT 100,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id            TEXT PRIMARY KEY,
  account_id    TEXT,
  media_id      TEXT,
  parent_id     TEXT,
  from_id       TEXT,
  from_username TEXT,
  text          TEXT,
  rule_id       INTEGER,
  status        TEXT NOT NULL,
  note          TEXT,
  received_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_received ON comments(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_rule_user ON comments(rule_id, from_id);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id  TEXT    NOT NULL,
  rule_id     INTEGER,
  type        TEXT    NOT NULL,
  payload     TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  run_at      INTEGER NOT NULL,
  last_error  TEXT,
  result      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_comment ON jobs(comment_id);
`;

const RULE_FIELDS = [
  'name', 'enabled', 'match_type', 'keywords', 'media_ids', 'reply_enabled', 'reply_variants',
  'dm_enabled', 'dm_text', 'dm_button_title', 'dm_button_url', 'once_per_user', 'delay_seconds', 'priority',
];

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function rowToRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    match_type: row.match_type,
    keywords: parseJson(row.keywords, []),
    media_ids: parseJson(row.media_ids, []),
    reply_enabled: !!row.reply_enabled,
    reply_variants: parseJson(row.reply_variants, []),
    dm_enabled: !!row.dm_enabled,
    dm_text: row.dm_text,
    dm_button_title: row.dm_button_title,
    dm_button_url: row.dm_button_url,
    once_per_user: !!row.once_per_user,
    delay_seconds: row.delay_seconds,
    priority: row.priority,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function ruleToColumns(rule) {
  return {
    name: rule.name,
    enabled: rule.enabled ? 1 : 0,
    match_type: rule.match_type,
    keywords: JSON.stringify(rule.keywords),
    media_ids: JSON.stringify(rule.media_ids),
    reply_enabled: rule.reply_enabled ? 1 : 0,
    reply_variants: JSON.stringify(rule.reply_variants),
    dm_enabled: rule.dm_enabled ? 1 : 0,
    dm_text: rule.dm_text,
    dm_button_title: rule.dm_button_title,
    dm_button_url: rule.dm_button_url,
    once_per_user: rule.once_per_user ? 1 : 0,
    delay_seconds: rule.delay_seconds,
    priority: rule.priority,
  };
}

function openDatabase(filename) {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return createStore(db);
}

function createStore(db) {
  const now = () => Date.now();

  const store = {
    raw: db,

    transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    // ---------- Einstellungen ----------
    getSetting(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    },
    setSetting(key, value) {
      if (value === null || value === undefined) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      } else {
        db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run(key, String(value));
      }
    },

    // ---------- Regeln ----------
    listRules() {
      return db.prepare('SELECT * FROM rules ORDER BY priority ASC, id ASC').all().map(rowToRule);
    },
    listEnabledRules() {
      return db.prepare('SELECT * FROM rules WHERE enabled = 1 ORDER BY priority ASC, id ASC').all().map(rowToRule);
    },
    getRule(id) {
      return rowToRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(id));
    },
    createRule(rule) {
      const cols = ruleToColumns(rule);
      const ts = now();
      const names = [...RULE_FIELDS, 'created_at', 'updated_at'];
      const values = [...RULE_FIELDS.map((f) => cols[f]), ts, ts];
      const info = db
        .prepare(`INSERT INTO rules (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
        .run(...values);
      return store.getRule(Number(info.lastInsertRowid));
    },
    updateRule(id, rule) {
      const cols = ruleToColumns(rule);
      const sets = RULE_FIELDS.map((f) => `${f} = ?`).join(', ');
      const info = db
        .prepare(`UPDATE rules SET ${sets}, updated_at = ? WHERE id = ?`)
        .run(...RULE_FIELDS.map((f) => cols[f]), now(), id);
      return info.changes > 0 ? store.getRule(id) : null;
    },
    deleteRule(id) {
      return db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0;
    },
    ruleStats() {
      const rows = db
        .prepare(
          `SELECT c.rule_id AS rule_id,
                  COUNT(DISTINCT c.id) AS matched,
                  COUNT(DISTINCT CASE WHEN j.type = 'reply' AND j.status = 'done' THEN j.id END) AS replies_sent,
                  COUNT(DISTINCT CASE WHEN j.type = 'dm' AND j.status = 'done' THEN j.id END) AS dms_sent
             FROM comments c
             LEFT JOIN jobs j ON j.comment_id = c.id
            WHERE c.status = 'matched' AND c.rule_id IS NOT NULL
            GROUP BY c.rule_id`,
        )
        .all();
      const stats = {};
      for (const r of rows) stats[r.rule_id] = { matched: r.matched, replies_sent: r.replies_sent, dms_sent: r.dms_sent };
      return stats;
    },

    // ---------- Kommentare ----------
    /** Legt den Kommentar an. Gibt false zurück, wenn er schon bekannt ist (doppelte Webhook-Zustellung). */
    insertComment(c) {
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO comments
             (id, account_id, media_id, parent_id, from_id, from_username, text, rule_id, status, note, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.id,
          c.account_id ?? null,
          c.media_id ?? null,
          c.parent_id ?? null,
          c.from_id ?? null,
          c.from_username ?? null,
          c.text ?? '',
          c.rule_id ?? null,
          c.status,
          c.note ?? null,
          c.received_at ?? now(),
        );
      return info.changes > 0;
    },
    hasComment(id) {
      return !!db.prepare('SELECT 1 FROM comments WHERE id = ?').get(id);
    },
    hasUserTriggeredRule(ruleId, fromId) {
      if (!fromId) return false;
      return !!db
        .prepare(`SELECT 1 FROM comments WHERE rule_id = ? AND from_id = ? AND status = 'matched' LIMIT 1`)
        .get(ruleId, fromId);
    },
    listComments({ limit = 50, offset = 0 } = {}) {
      const comments = db
        .prepare(
          `SELECT c.*, r.name AS rule_name
             FROM comments c LEFT JOIN rules r ON r.id = c.rule_id
            ORDER BY c.received_at DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset);
      if (comments.length === 0) return [];
      const ids = comments.map((c) => c.id);
      const jobs = db
        .prepare(
          `SELECT id, comment_id, type, status, attempts, run_at, last_error, updated_at
             FROM jobs WHERE comment_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
        )
        .all(...ids);
      const byComment = {};
      for (const j of jobs) (byComment[j.comment_id] ||= []).push(j);
      return comments.map((c) => ({ ...c, jobs: byComment[c.id] || [] }));
    },
    countComments() {
      return db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
    },

    // ---------- Jobs (Warteschlange) ----------
    enqueueJob({ comment_id, rule_id, type, payload, run_at }) {
      const ts = now();
      const info = db
        .prepare(
          `INSERT INTO jobs (comment_id, rule_id, type, payload, status, attempts, run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(comment_id, rule_id ?? null, type, JSON.stringify(payload), run_at, ts, ts);
      return Number(info.lastInsertRowid);
    },
    /** Holt den nächsten fälligen Job und markiert ihn als "running". */
    claimNextJob(at = now()) {
      return store.transaction(() => {
        const row = db
          .prepare(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC, id ASC LIMIT 1`)
          .get(at);
        if (!row) return null;
        db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(
          now(),
          row.id,
        );
        return { ...row, attempts: row.attempts + 1, payload: parseJson(row.payload, {}) };
      });
    },
    completeJob(id, result) {
      db.prepare(`UPDATE jobs SET status = 'done', result = ?, last_error = NULL, updated_at = ? WHERE id = ?`).run(
        result ? JSON.stringify(result) : null,
        now(),
        id,
      );
    },
    retryJob(id, error, runAt) {
      db.prepare(`UPDATE jobs SET status = 'pending', last_error = ?, run_at = ?, updated_at = ? WHERE id = ?`).run(
        error,
        runAt,
        now(),
        id,
      );
    },
    failJob(id, error) {
      db.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(error, now(), id);
    },
    /** Fehlgeschlagenen Job erneut einplanen (z. B. nachdem der Token erneuert wurde). */
    requeueJob(id, runAt = now()) {
      const info = db
        .prepare(
          `UPDATE jobs SET status = 'pending', attempts = 0, run_at = ?, updated_at = ? WHERE id = ? AND status = 'failed'`,
        )
        .run(runAt, now(), id);
      return info.changes > 0;
    },
    /** Jobs, die beim Absturz/Neustart mitten in der Bearbeitung waren, wieder freigeben. */
    resetRunningJobs() {
      db.prepare(`UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'`).run(now());
    },
    jobCounts() {
      const rows = db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
      const counts = { pending: 0, running: 0, done: 0, failed: 0 };
      for (const r of rows) counts[r.status] = r.n;
      return counts;
    },
  };

  return store;
}

module.exports = { openDatabase };
