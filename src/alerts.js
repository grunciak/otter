'use strict';

const { db, getSetting } = require('./db');
const { sendAlertEmail } = require('./mailer');

function fmtPl(dateIso) {
  if (!dateIso) return '—';
  return new Date(dateIso).toLocaleString('pl-PL', {
    timeZone: getSetting('timezone', 'Europe/Warsaw'),
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

function minutesSince(dateIso) {
  return (Date.now() - new Date(dateIso).getTime()) / 60000;
}

function getState(key) {
  return db.prepare('SELECT * FROM alert_state WHERE key = ?').get(key)
    || { key, active: 0, since: null, last_notified_at: null, detail: null };
}

function saveState(state) {
  db.prepare(`INSERT INTO alert_state (key, active, since, last_notified_at, detail)
    VALUES (@key, @active, @since, @last_notified_at, @detail)
    ON CONFLICT(key) DO UPDATE SET
      active = excluded.active, since = excluded.since,
      last_notified_at = excluded.last_notified_at, detail = excluded.detail`).run(state);
}

function logAlert({ sensorKey, type, event, message, emailResult }) {
  db.prepare(`INSERT INTO alert_log (sensor_key, type, event, message, email_sent, email_error)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sensorKey, type, event, message, emailResult.sent ? 1 : 0, emailResult.error);
}

// Przejście stanu alertu + wysyłka e-maili z deduplikacją.
// isActive: czy warunek alarmowy trwa TERAZ; buildEmail(event) → {subject,title,lines,kind}
async function transition({ key, sensorKey, type, isActive, message, buildEmail }) {
  const state = getState(key);
  const nowIso = new Date().toISOString();
  const reminderMin = parseInt(getSetting('reminder_minutes', '0'), 10) || 0;

  if (isActive && !state.active) {
    // nowy alert
    const emailResult = await sendAlertEmail(buildEmail('start'));
    saveState({ key, active: 1, since: nowIso, last_notified_at: nowIso, detail: message });
    logAlert({ sensorKey, type, event: 'start', message, emailResult });
  } else if (isActive && state.active) {
    // alert trwa — ewentualne przypomnienie
    saveState({ ...state, detail: message });
    if (reminderMin > 0 && state.last_notified_at && minutesSince(state.last_notified_at) >= reminderMin) {
      const emailResult = await sendAlertEmail(buildEmail('reminder'));
      saveState({ ...state, last_notified_at: nowIso, detail: message });
      logAlert({ sensorKey, type, event: 'reminder', message, emailResult });
    }
  } else if (!isActive && state.active) {
    // powrót do normy
    const emailResult = await sendAlertEmail(buildEmail('end'));
    saveState({ key, active: 0, since: null, last_notified_at: nowIso, detail: null });
    logAlert({ sensorKey, type, event: 'end', message: `Powrót do normy: ${message}`, emailResult });
  }
}

async function checkStale(sensor, status) {
  const lastDataAt = status && status.last_data_at ? status.last_data_at : null;
  const stale = !lastDataAt || minutesSince(lastDataAt) > sensor.stale_minutes;
  // nie alarmujemy, dopóki sonda nie została ani razu sprawdzona
  if (!status || !status.last_checked_at) return;

  const ageTxt = lastDataAt
    ? `${Math.round(minutesSince(lastDataAt))} min temu`
    : 'nigdy';
  const message = `Brak danych z sondy ${sensor.label} (ostatnie dane: ${ageTxt}, limit: ${sensor.stale_minutes} min)`;

  await transition({
    key: `stale:${sensor.id}`,
    sensorKey: sensor.key,
    type: 'stale',
    isActive: stale,
    message,
    buildEmail: (event) => ({
      kind: event === 'end' ? 'ok' : 'alert',
      subject: event === 'end'
        ? `✅ [Otter] ${sensor.label}: dane znów napływają`
        : `🚨 [Otter] ${sensor.label}: brak danych z sondy`,
      title: event === 'end'
        ? `Sonda ${sensor.label} znów przesyła dane`
        : `Sonda ${sensor.label} przestała przesyłać dane`,
      lines: [
        ['Sonda', sensor.label],
        ['Ostatnie dane', lastDataAt ? fmtPl(lastDataAt) : 'nigdy nie odebrano'],
        ['Limit braku danych', `${sensor.stale_minutes} min`],
        ['Ostatni błąd pobierania', (status && status.last_error) || 'brak'],
        ['Sprawdzono', fmtPl(new Date().toISOString())],
      ],
    }),
  });
}

function latestValue(sensorId, metric) {
  return db.prepare(`SELECT value, measured_at FROM readings
    WHERE sensor_id = ? AND metric = ?
    ORDER BY measured_at DESC, id DESC LIMIT 1`).get(sensorId, metric);
}

async function checkRule(sensor, rule) {
  const reading = latestValue(sensor.id, rule.metric);
  if (!reading) return; // metryka jeszcze nie wystąpiła — nie oceniamy

  const v = reading.value;
  let violation = null;
  if (rule.max_value !== null && v > rule.max_value) {
    violation = `powyżej maksimum (${v} > ${rule.max_value})`;
  } else if (rule.min_value !== null && v < rule.min_value) {
    violation = `poniżej minimum (${v} < ${rule.min_value})`;
  }

  const range = [
    rule.min_value !== null ? `min ${rule.min_value}` : null,
    rule.max_value !== null ? `max ${rule.max_value}` : null,
  ].filter(Boolean).join(', ');

  const message = violation
    ? `${sensor.label} / ${rule.metric}: wartość ${v} ${violation}`
    : `${sensor.label} / ${rule.metric}: wartość ${v} w normie (${range})`;

  await transition({
    key: `rule:${rule.id}`,
    sensorKey: sensor.key,
    type: 'threshold',
    isActive: Boolean(violation),
    message,
    buildEmail: (event) => ({
      kind: event === 'end' ? 'ok' : 'alert',
      subject: event === 'end'
        ? `✅ [Otter] ${sensor.label}: ${rule.metric} wróciło do normy`
        : `🚨 [Otter] ${sensor.label}: ${rule.metric} poza zakresem`,
      title: event === 'end'
        ? `Pomiar ${rule.metric} wrócił do normy`
        : `Pomiar ${rule.metric} przekroczył ustalony próg`,
      lines: [
        ['Sonda', sensor.label],
        ['Pomiar', rule.metric],
        ['Aktualna wartość', String(v)],
        ['Dozwolony zakres', range || 'brak'],
        ['Czas pomiaru', fmtPl(reading.measured_at)],
      ],
    }),
  });
}

async function evaluateAlerts() {
  const sensors = db.prepare('SELECT * FROM sensors WHERE enabled = 1').all();
  for (const sensor of sensors) {
    const status = db.prepare('SELECT * FROM sensor_status WHERE sensor_id = ?').get(sensor.id);
    await checkStale(sensor, status);
    const rules = db.prepare('SELECT * FROM rules WHERE sensor_id = ? AND enabled = 1').all(sensor.id);
    for (const rule of rules) {
      await checkRule(sensor, rule);
    }
  }
}

module.exports = { evaluateAlerts };
