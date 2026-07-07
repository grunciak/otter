'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./src/config');
const { db, getSetting, setSetting, syncSensors } = require('./src/db');
const auth = require('./src/auth');
const { startPolling, pollAll } = require('./src/poller');
const { sendAlertEmail, recipients } = require('./src/mailer');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1); // Railway stoi za proxy

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      // Railway terminuje TLS na brzegu; wymuszanie HTTPS w CSP psuje pracę lokalną
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(express.json({ limit: '100kb' }));
app.use(auth.sessionMiddleware());

// Ochrona CSRF: POST tylko z JSON-owym Content-Type (formularz cross-site może
// wysłać POST bez preflight, ale nie ustawi application/json). PUT/DELETE/PATCH
// wymuszają preflight CORS, a cookie ma SameSite=Lax.
app.use('/api', (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Wymagany Content-Type: application/json' });
  }
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zbyt wiele prób logowania. Spróbuj ponownie za kilkanaście minut.' },
});

// ---------- Autoryzacja ----------

app.post('/api/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const user = auth.verifyLogin(email, password);
  if (!user) return res.status(401).json({ error: 'Nieprawidłowy e-mail lub hasło' });
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Błąd sesji' });
    req.session.userId = user.id;
    req.session.email = user.email;
    res.json({ ok: true, email: user.email });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Strony publiczne
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/login.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.js'));
});

// Wszystko poniżej wymaga zalogowania
app.use(auth.requireAuth);

app.get('/api/me', (req, res) => res.json({ email: req.session.email }));

app.post('/api/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'Nowe hasło musi mieć min. 8 znaków' });
  }
  const user = auth.verifyLogin(req.session.email, currentPassword);
  if (!user) return res.status(401).json({ error: 'Aktualne hasło jest nieprawidłowe' });
  auth.changePassword(user.id, String(newPassword));
  res.json({ ok: true });
});

// ---------- Użytkownicy panelu ----------

app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id, email, created_at FROM users ORDER BY email').all();
  res.json({ users, meId: req.session.userId });
});

app.post('/api/users', (req, res) => {
  const { email, password } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
    return res.status(400).json({ error: 'Nieprawidłowy adres e-mail' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Hasło musi mieć min. 8 znaków' });
  }
  if (!auth.createUser(em, String(password))) {
    return res.status(400).json({ error: 'Użytkownik o tym adresie już istnieje' });
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Nie możesz usunąć konta, na które jesteś zalogowany' });
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count <= 1) return res.status(400).json({ error: 'Nie można usunąć ostatniego użytkownika' });
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Nie znaleziono użytkownika' });
  // wylogowanie usuniętego użytkownika (sesje trzymają userId w JSON)
  db.prepare("DELETE FROM sessions WHERE data LIKE ?").run(`%"userId":${id}%`);
  res.json({ ok: true });
});

// ---------- Dane ----------

app.get('/api/overview', (req, res) => {
  const sensors = db.prepare(`
    SELECT s.*, st.last_success_at, st.last_data_at, st.last_error, st.last_checked_at
    FROM sensors s LEFT JOIN sensor_status st ON st.sensor_id = s.id
    ORDER BY s.key`).all();

  const latestStmt = db.prepare(`
    SELECT r.metric, r.value, r.measured_at FROM readings r
    JOIN (SELECT metric, MAX(measured_at) AS m FROM readings WHERE sensor_id = ? GROUP BY metric) x
      ON x.metric = r.metric AND x.m = r.measured_at
    WHERE r.sensor_id = ? GROUP BY r.metric`);

  const activeAlerts = db.prepare('SELECT * FROM alert_state WHERE active = 1').all();
  const rules = db.prepare('SELECT * FROM rules').all();

  const result = sensors.map((s) => {
    const metrics = latestStmt.all(s.id, s.id);
    const staleMs = s.last_data_at ? Date.now() - new Date(s.last_data_at).getTime() : null;
    const isStale = activeAlerts.some((a) => a.key === `stale:${s.id}`);
    const sensorRuleIds = new Set(rules.filter((r) => r.sensor_id === s.id).map((r) => `rule:${r.id}`));
    const violated = activeAlerts.filter((a) => sensorRuleIds.has(a.key)).map((a) => a.detail);
    return {
      id: s.id,
      key: s.key,
      label: s.label,
      enabled: !!s.enabled,
      staleMinutes: s.stale_minutes,
      lastDataAt: s.last_data_at,
      lastCheckedAt: s.last_checked_at,
      lastError: s.last_error,
      dataAgeMinutes: staleMs !== null ? Math.round(staleMs / 60000) : null,
      metrics,
      alert: isStale ? 'stale' : (violated.length ? 'threshold' : null),
      violations: violated,
    };
  });

  res.json({
    sensors: result,
    pollIntervalSeconds: config.pollIntervalSeconds,
    activeAlertCount: activeAlerts.length,
  });
});

app.get('/api/sensors/:id/history', (req, res) => {
  const sensorId = parseInt(req.params.id, 10);
  const hours = Math.min(24 * 30, Math.max(1, parseInt(req.query.hours, 10) || 24));
  const metric = req.query.metric;
  const params = [sensorId, `-${hours} hours`];
  let metricFilter = '';
  if (metric) { metricFilter = 'AND metric = ?'; params.push(metric); }
  const rows = db.prepare(`
    SELECT metric, value, measured_at FROM readings
    WHERE sensor_id = ? AND measured_at >= datetime('now', ?) ${metricFilter}
    ORDER BY measured_at ASC`).all(...params);
  res.json({ rows });
});

app.put('/api/sensors/:id', (req, res) => {
  const { label, staleMinutes, enabled } = req.body || {};
  const stale = parseInt(staleMinutes, 10);
  if (!Number.isFinite(stale) || stale < 1 || stale > 100000) {
    return res.status(400).json({ error: 'Limit braku danych musi być liczbą minut (>= 1)' });
  }
  const r = db.prepare('UPDATE sensors SET label = ?, stale_minutes = ?, enabled = ? WHERE id = ?')
    .run(String(label || '').trim() || 'sonda', stale, enabled ? 1 : 0, parseInt(req.params.id, 10));
  if (r.changes === 0) return res.status(404).json({ error: 'Nie znaleziono sondy' });
  res.json({ ok: true });
});

// Metryki dostępne dla danej sondy (do formularza reguł)
app.get('/api/sensors/:id/metrics', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT metric FROM readings WHERE sensor_id = ? ORDER BY metric')
    .all(parseInt(req.params.id, 10));
  res.json({ metrics: rows.map((r) => r.metric) });
});

// ---------- Reguły progowe ----------

app.get('/api/rules', (req, res) => {
  const rules = db.prepare(`
    SELECT r.*, s.label AS sensor_label, s.key AS sensor_key,
           (SELECT active FROM alert_state WHERE key = 'rule:' || r.id) AS alert_active
    FROM rules r JOIN sensors s ON s.id = r.sensor_id ORDER BY s.key, r.metric`).all();
  res.json({ rules });
});

function parseRuleBody(body) {
  const sensorId = parseInt(body.sensorId, 10);
  const metric = String(body.metric || '').trim();
  const min = body.min === null || body.min === '' || body.min === undefined ? null : Number(body.min);
  const max = body.max === null || body.max === '' || body.max === undefined ? null : Number(body.max);
  if (!Number.isFinite(sensorId)) return { error: 'Wybierz sondę' };
  if (!metric) return { error: 'Podaj nazwę pomiaru' };
  if (min === null && max === null) return { error: 'Podaj minimum lub maksimum' };
  if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) {
    return { error: 'Progi muszą być liczbami' };
  }
  if (min !== null && max !== null && min > max) return { error: 'Minimum nie może być większe od maksimum' };
  return { sensorId, metric, min, max, enabled: body.enabled === undefined ? 1 : (body.enabled ? 1 : 0) };
}

app.post('/api/rules', (req, res) => {
  const p = parseRuleBody(req.body || {});
  if (p.error) return res.status(400).json({ error: p.error });
  const sensor = db.prepare('SELECT id FROM sensors WHERE id = ?').get(p.sensorId);
  if (!sensor) return res.status(404).json({ error: 'Nie znaleziono sondy' });
  const r = db.prepare('INSERT INTO rules (sensor_id, metric, min_value, max_value, enabled) VALUES (?, ?, ?, ?, ?)')
    .run(p.sensorId, p.metric, p.min, p.max, p.enabled);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/rules/:id', (req, res) => {
  const p = parseRuleBody(req.body || {});
  if (p.error) return res.status(400).json({ error: p.error });
  const r = db.prepare('UPDATE rules SET sensor_id = ?, metric = ?, min_value = ?, max_value = ?, enabled = ? WHERE id = ?')
    .run(p.sensorId, p.metric, p.min, p.max, p.enabled, parseInt(req.params.id, 10));
  if (r.changes === 0) return res.status(404).json({ error: 'Nie znaleziono reguły' });
  res.json({ ok: true });
});

app.delete('/api/rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM alert_state WHERE key = ?').run(`rule:${id}`);
  const r = db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Nie znaleziono reguły' });
  res.json({ ok: true });
});

// ---------- Alerty / historia ----------

app.get('/api/alerts', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const log = db.prepare('SELECT * FROM alert_log ORDER BY id DESC LIMIT ?').all(limit);
  const active = db.prepare('SELECT * FROM alert_state WHERE active = 1').all();
  res.json({ log, active });
});

// ---------- Ustawienia ----------

app.get('/api/settings', (req, res) => {
  res.json({
    alertEmails: getSetting('alert_emails', ''),
    reminderMinutes: parseInt(getSetting('reminder_minutes', '0'), 10) || 0,
    timezone: getSetting('timezone', 'Europe/Warsaw'),
    smtpConfigured: Boolean(config.smtp.host),
    pollIntervalSeconds: config.pollIntervalSeconds,
  });
});

app.put('/api/settings', (req, res) => {
  const { alertEmails, reminderMinutes, timezone } = req.body || {};
  if (alertEmails !== undefined) {
    const emails = String(alertEmails).split(',').map((s) => s.trim()).filter(Boolean);
    const bad = emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (bad) return res.status(400).json({ error: `Nieprawidłowy adres: ${bad}` });
    setSetting('alert_emails', emails.join(', '));
  }
  if (reminderMinutes !== undefined) {
    const m = parseInt(reminderMinutes, 10);
    if (!Number.isFinite(m) || m < 0) return res.status(400).json({ error: 'Przypomnienie: podaj liczbę minut (0 = wyłączone)' });
    setSetting('reminder_minutes', String(m));
  }
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('pl-PL', { timeZone: String(timezone) });
    } catch (_) {
      return res.status(400).json({ error: 'Nieprawidłowa strefa czasowa' });
    }
    setSetting('timezone', String(timezone));
  }
  res.json({ ok: true });
});

app.post('/api/test-email', async (req, res) => {
  const result = await sendAlertEmail({
    kind: 'info',
    subject: '🔔 [Otter] Testowe powiadomienie',
    title: 'To jest testowa wiadomość z Otter Monitor',
    lines: [
      ['Adresaci', recipients().join(', ') || 'brak'],
      ['Wysłano', new Date().toLocaleString('pl-PL', { timeZone: getSetting('timezone', 'Europe/Warsaw') })],
    ],
  });
  if (!result.sent) return res.status(500).json({ error: result.error });
  res.json({ ok: true });
});

app.post('/api/poll-now', async (req, res) => {
  await pollAll();
  res.json({ ok: true });
});

// Podgląd surowej odpowiedzi API (diagnostyka)
app.get('/api/sensors/:id/raw', (req, res) => {
  const row = db.prepare('SELECT last_payload, last_checked_at, last_error FROM sensor_status WHERE sensor_id = ?')
    .get(parseInt(req.params.id, 10));
  res.json(row || {});
});

// ---------- Statyczne ----------

app.get('/vendor/chart.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// ---------- Start ----------

auth.seedAdmin();
syncSensors();
startPolling();

app.listen(config.port, () => {
  console.log(`[otter] nasłuch na porcie ${config.port}`);
});
