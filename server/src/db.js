'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgres://septona:septona@localhost:5432/septona_kiosk',
  max: 10,
});

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  location              TEXT,
  key_hash              TEXT NOT NULL,
  key_prefix            TEXT NOT NULL,
  revoked               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ,
  last_manifest_version INTEGER,
  docs_cached           INTEGER,
  storage_bytes         BIGINT,
  app_version           TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id            TEXT PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  name_bg       TEXT NOT NULL,
  name_en       TEXT NOT NULL DEFAULT '',
  icon          TEXT NOT NULL DEFAULT 'doc',
  colour        TEXT NOT NULL DEFAULT '#26307A',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  cycle_seconds INTEGER,
  visible       BOOLEAN NOT NULL DEFAULT TRUE,
  parent_id     TEXT REFERENCES categories(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,
  category_id        TEXT NOT NULL REFERENCES categories(id),
  title_bg           TEXT NOT NULL,
  title_en           TEXT NOT NULL DEFAULT '',
  language           TEXT NOT NULL DEFAULT 'bg' CHECK (language IN ('bg','en','both')),
  tags               TEXT[] NOT NULL DEFAULT '{}',
  sort_order         INTEGER NOT NULL DEFAULT 0,
  pinned             BOOLEAN NOT NULL DEFAULT FALSE,
  current_version_id TEXT,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_category_idx ON documents(category_id);
CREATE INDEX IF NOT EXISTS documents_live_idx ON documents(deleted_at);

CREATE TABLE IF NOT EXISTS document_versions (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  filename        TEXT NOT NULL,
  stored_path     TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  mime            TEXT NOT NULL DEFAULT 'application/pdf',
  page_count      INTEGER,
  note            TEXT,
  source_filename TEXT,
  converted       BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_by     TEXT,
  uploaded_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_number)
);
CREATE INDEX IF NOT EXISTS versions_doc_idx ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS versions_sha_idx ON document_versions(sha256);

-- Append-only. Nothing in the application ever issues UPDATE or DELETE here.
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL,
  actor_id   TEXT,
  actor_name TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  summary    TEXT NOT NULL,
  before     JSONB,
  after      JSONB,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS content_state (
  id               INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  manifest_version INTEGER NOT NULL DEFAULT 1,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO content_state (id) VALUES (1) ON CONFLICT DO NOTHING;
`;

/**
 * Every key here is read by the panel. Automatic cycling between categories was removed
 * in 1.0.6 — the panel now waits to be touched — so `cycleEnabled`, `cycleSeconds` and
 * `idleResumeSeconds` are gone rather than left as controls that quietly do nothing.
 * Rows for retired keys may still sit in the settings table on an existing install;
 * getSettings ignores them.
 */
const DEFAULT_SETTINGS = {
  kioskTitle: 'СЕПТОНА — Документи',
  defaultLanguage: 'bg',
  homeAfterIdleSeconds: 60,
  syncIntervalMinutes: 15,
};

async function init() {
  await q(SCHEMA);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await q(
      'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING',
      [key, JSON.stringify(value)]
    );
  }
}

/** Bump the manifest version so every kiosk notices there is new content. */
async function bumpManifest(client) {
  const runner = client || { query: q };
  const { rows } = await runner.query(
    'UPDATE content_state SET manifest_version = manifest_version + 1, updated_at = now() WHERE id = 1 RETURNING manifest_version'
  );
  return rows[0].manifest_version;
}

async function getSettings() {
  const { rows } = await q('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  // Only known keys: an upgraded install still has rows for retired settings, and handing
  // them back would put dead fields into the manifest and the admin form again.
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  return out;
}

module.exports = { pool, q, tx, init, bumpManifest, getSettings, DEFAULT_SETTINGS };
