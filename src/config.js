'use strict';

const path = require('path');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function intEnv(name, fallback) {
  const v = parseInt(env(name, ''), 10);
  return Number.isFinite(v) ? v : fallback;
}

const dataDir = env('DATA_DIR', path.join(__dirname, '..', 'data'));

// Sondy: SENSOR_URLS = lista URL-i rozdzielona przecinkami,
// albo SENSOR_BASE_URL + SENSOR_TOKEN + SENSOR_TABLES.
function sensorUrls() {
  const raw = env('SENSOR_URLS', '');
  if (raw.trim()) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const base = env('SENSOR_BASE_URL', 'https://fwtw.tech/otter/api.php');
  const token = env('SENSOR_TOKEN', '');
  const tables = env('SENSOR_TABLES', 'sensor_1,sensor_2,sensor_3')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return tables.map((t) => `${base}?token=${encodeURIComponent(token)}&table=${encodeURIComponent(t)}`);
}

function sensorName(url, index) {
  try {
    const u = new URL(url);
    const table = u.searchParams.get('table');
    if (table) return table;
  } catch (_) { /* URL bez parametru table */ }
  return `sensor_${index + 1}`;
}

module.exports = {
  port: intEnv('PORT', 3000),
  dataDir,
  dbPath: env('DB_PATH', path.join(dataDir, 'otter.db')),
  sessionSecret: env('SESSION_SECRET', ''),
  adminEmail: env('ADMIN_EMAIL', ''),
  adminPassword: env('ADMIN_PASSWORD', ''),
  pollIntervalSeconds: Math.max(30, intEnv('POLL_INTERVAL_SECONDS', 300)),
  fetchTimeoutMs: intEnv('FETCH_TIMEOUT_MS', 20000),
  trustProxy: env('TRUST_PROXY', '1') !== '0',
  smtp: {
    host: env('SMTP_HOST', ''),
    port: intEnv('SMTP_PORT', 587),
    secure: env('SMTP_SECURE', 'false') === 'true',
    user: env('SMTP_USER', ''),
    pass: env('SMTP_PASS', ''),
    from: env('MAIL_FROM', env('SMTP_USER', 'otter-monitor@localhost')),
  },
  appUrl: env('APP_URL', ''),
  sensorUrls,
  sensorName,
};
