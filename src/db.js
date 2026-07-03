'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sensors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,           -- np. sensor_1
  label TEXT NOT NULL,                -- nazwa wyświetlana
  url TEXT NOT NULL,
  stale_minutes INTEGER NOT NULL DEFAULT 30,  -- po ilu minutach bez danych alarmować
  enabled INTEGER NOT NULL DEFAULT 1
);

-- Ostatnio widziane odczyty (spłaszczone metryki z API)
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor_id INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  measured_at TEXT NOT NULL,          -- ISO z API (lub czas pobrania, gdy brak)
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_readings_lookup
  ON readings (sensor_id, metric, measured_at);

-- Stan pobierania per sonda (do wykrywania braku danych)
CREATE TABLE IF NOT EXISTS sensor_status (
  sensor_id INTEGER PRIMARY KEY REFERENCES sensors(id) ON DELETE CASCADE,
  last_success_at TEXT,               -- ostatnie udane pobranie
  last_data_at TEXT,                  -- znacznik czasu najnowszego rekordu z API
  last_error TEXT,
  last_checked_at TEXT,
  last_payload TEXT                   -- surowa odpowiedź (skrócona) do podglądu
);

-- Reguły progowe: min/max dla konkretnej metryki konkretnej sondy
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor_id INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  min_value REAL,
  max_value REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stan alertów (deduplikacja powiadomień)
-- key: 'stale:<sensor_id>' albo 'rule:<rule_id>'
CREATE TABLE IF NOT EXISTS alert_state (
  key TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0,
  since TEXT,
  last_notified_at TEXT,
  detail TEXT
);

-- Historia alertów (do widoku w UI)
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sensor_key TEXT NOT NULL,
  type TEXT NOT NULL,                 -- 'stale' | 'threshold'
  event TEXT NOT NULL,                -- 'start' | 'end' | 'reminder'
  message TEXT NOT NULL,
  email_sent INTEGER NOT NULL DEFAULT 0,
  email_error TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

// Synchronizacja listy sond z konfiguracji do bazy (dodaje nowe, aktualizuje URL-e)
function syncSensors() {
  const urls = config.sensorUrls();
  const upsert = db.prepare(`INSERT INTO sensors (key, label, url) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET url = excluded.url`);
  urls.forEach((url, i) => {
    const key = config.sensorName(url, i);
    upsert.run(key, key.replace(/_/g, ' '), url);
  });
}

module.exports = { db, getSetting, setSetting, syncSensors };
