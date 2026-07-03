'use strict';

const config = require('./config');
const { db } = require('./db');
const { parsePayload } = require('./parser');
const { evaluateAlerts } = require('./alerts');

const MAX_PAYLOAD_PREVIEW = 4000;

async function fetchSensor(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      throw new Error('Odpowiedź nie jest poprawnym JSON');
    }
    return { payload, text };
  } finally {
    clearTimeout(timer);
  }
}

function storeReadings(sensor, allRows) {
  // rekordów bez znacznika czasu nie da się deduplikować między cyklami —
  // zapisujemy tylko ostatni z nich (bieżący stan) z czasem pobrania
  const timed = allRows.filter((r) => r.measuredAt);
  const untimed = allRows.filter((r) => !r.measuredAt);
  const rows = untimed.length ? [...timed, untimed[untimed.length - 1]] : timed;
  if (rows.length === 0) return;
  const lastRow = db.prepare(
    'SELECT MAX(measured_at) AS m FROM readings WHERE sensor_id = ?'
  ).get(sensor.id);
  const lastStored = lastRow && lastRow.m ? new Date(lastRow.m) : null;

  const insert = db.prepare(
    'INSERT INTO readings (sensor_id, metric, value, measured_at) VALUES (?, ?, ?, ?)'
  );
  const now = new Date();

  const tx = db.transaction(() => {
    for (const row of rows) {
      const at = row.measuredAt || now;
      // pomijamy rekordy już zapisane (starsze lub równe ostatniemu znacznikowi)
      if (row.measuredAt && lastStored && row.measuredAt <= lastStored) continue;
      for (const [metric, value] of Object.entries(row.metrics)) {
        insert.run(sensor.id, metric, value, at.toISOString());
      }
    }
  });
  tx();
}

function pruneReadings() {
  // trzymamy 30 dni odczytów i 90 dni historii alertów, żeby baza nie rosła w nieskończoność
  db.prepare("DELETE FROM readings WHERE measured_at < datetime('now', '-30 days')").run();
  db.prepare("DELETE FROM alert_log WHERE created_at < datetime('now', '-90 days')").run();
}

async function pollSensor(sensor) {
  const nowIso = new Date().toISOString();
  try {
    const { payload, text } = await fetchSensor(sensor.url);
    const { rows, latestAt } = parsePayload(payload);
    storeReadings(sensor, rows);

    // gdy API nie podaje znaczników czasu, ale zwraca dane — traktujemy czas
    // pobrania jako czas danych (staleness wykryje dopiero brak odpowiedzi)
    const dataAt = latestAt ? latestAt.toISOString() : (rows.length > 0 ? nowIso : null);

    db.prepare(`
      INSERT INTO sensor_status (sensor_id, last_success_at, last_data_at, last_error, last_checked_at, last_payload)
      VALUES (?, ?, ?, NULL, ?, ?)
      ON CONFLICT(sensor_id) DO UPDATE SET
        last_success_at = excluded.last_success_at,
        last_data_at = COALESCE(excluded.last_data_at, sensor_status.last_data_at),
        last_error = NULL,
        last_checked_at = excluded.last_checked_at,
        last_payload = excluded.last_payload
    `).run(sensor.id, nowIso, dataAt, nowIso, text.slice(0, MAX_PAYLOAD_PREVIEW));
  } catch (err) {
    console.error(`[poller] ${sensor.key}: ${err.message}`);
    db.prepare(`
      INSERT INTO sensor_status (sensor_id, last_error, last_checked_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sensor_id) DO UPDATE SET
        last_error = excluded.last_error,
        last_checked_at = excluded.last_checked_at
    `).run(sensor.id, err.message, nowIso);
  }
}

let running = false;

async function pollAll() {
  if (running) return; // nie nakładamy cykli na siebie
  running = true;
  try {
    const sensors = db.prepare('SELECT * FROM sensors WHERE enabled = 1').all();
    await Promise.all(sensors.map(pollSensor));
    pruneReadings();
    await evaluateAlerts();
  } catch (err) {
    console.error('[poller] błąd cyklu:', err);
  } finally {
    running = false;
  }
}

function startPolling() {
  pollAll();
  setInterval(pollAll, config.pollIntervalSeconds * 1000);
  console.log(`[poller] start, interwał ${config.pollIntervalSeconds}s`);
}

module.exports = { startPolling, pollAll };
