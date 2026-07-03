'use strict';

/* ================= Pomocnicze ================= */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('401'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = (isError ? '⚠️ ' : '✓ ') + msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

const fmtTime = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'medium' });
function fmtDate(iso) { return iso ? fmtTime.format(new Date(iso)) : '—'; }

function fmtAge(minutes) {
  if (minutes === null || minutes === undefined) return 'nigdy';
  if (minutes < 1) return 'przed chwilą';
  if (minutes < 60) return `${Math.round(minutes)} min temu`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} godz. temu`;
  return `${Math.round(minutes / 1440)} dni temu`;
}

function fmtNum(v) {
  return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }).format(v);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ================= Router ================= */

const views = ['pulpit', 'reguly', 'alerty', 'ustawienia'];
function currentView() {
  const v = (location.hash || '#/pulpit').replace('#/', '');
  return views.includes(v) ? v : 'pulpit';
}

function renderRoute() {
  const v = currentView();
  views.forEach((name) => {
    $(`#view-${name}`).classList.toggle('active', name === v);
  });
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === v);
  });
  if (v === 'pulpit') loadDashboard();
  if (v === 'reguly') loadRules();
  if (v === 'alerty') loadAlerts();
  if (v === 'ustawienia') loadSettings();
}
window.addEventListener('hashchange', renderRoute);

/* ================= Pulpit ================= */

// stan wykresów per sonda: wybrana metryka, zakres, instancja Chart.js
const chartState = new Map();
let sensorsCache = [];

async function loadDashboard() {
  const data = await api('/api/overview').catch((e) => { toast(e.message, true); return null; });
  if (!data) return;
  sensorsCache = data.sensors;

  const badge = $('#alertBadge');
  badge.hidden = data.activeAlertCount === 0;
  badge.textContent = data.activeAlertCount;
  $('#pollInfo').textContent = `Odświeżanie co ${Math.round(data.pollIntervalSeconds / 60)} min.`;

  renderTiles(data);
  renderSensors(data.sensors);
}

function renderTiles(data) {
  const total = data.sensors.filter((s) => s.enabled).length;
  const okCount = data.sensors.filter((s) => s.enabled && !s.alert && !s.lastError).length;
  const newest = data.sensors
    .map((s) => s.lastCheckedAt).filter(Boolean).sort().pop();
  $('#tiles').replaceChildren(
    el('div', { class: 'tile' },
      el('div', { class: 't-label' }, 'Sondy w normie'),
      el('div', { class: `t-value ${okCount === total ? 'ok' : 'bad'}` }, `${okCount} / ${total}`)),
    el('div', { class: 'tile' },
      el('div', { class: 't-label' }, 'Aktywne alerty'),
      el('div', { class: `t-value ${data.activeAlertCount ? 'bad' : 'ok'}` }, String(data.activeAlertCount))),
    el('div', { class: 'tile' },
      el('div', { class: 't-label' }, 'Ostatnie sprawdzenie'),
      el('div', { class: 't-value', style: 'font-size:17px;padding-top:8px' }, newest ? fmtDate(newest) : '—')),
  );
}

function statusOf(sensor) {
  if (!sensor.enabled) return { cls: 'off', txt: 'wyłączona' };
  if (sensor.alert === 'stale') return { cls: 'bad', txt: 'brak danych' };
  if (sensor.alert === 'threshold') return { cls: 'bad', txt: 'próg przekroczony' };
  if (sensor.lastError) return { cls: 'bad', txt: 'błąd pobierania' };
  if (!sensor.lastDataAt) return { cls: 'off', txt: 'czekam na dane' };
  return { cls: 'ok', txt: 'w normie' };
}

function renderSensors(sensors) {
  const grid = $('#sensorGrid');
  grid.replaceChildren();
  if (sensors.length === 0) {
    grid.append(el('div', { class: 'loading' }, 'Brak skonfigurowanych sond (ustaw SENSOR_URLS).'));
    return;
  }
  for (const s of sensors) grid.append(sensorCard(s));
}

function sensorCard(s) {
  const st = statusOf(s);
  const state = chartState.get(s.id) || { metric: null, hours: 24, chart: null };
  if (!state.metric && s.metrics.length) state.metric = s.metrics[0].metric;
  // metryka mogła zniknąć po zmianie API
  if (state.metric && s.metrics.length && !s.metrics.some((m) => m.metric === state.metric)) {
    state.metric = s.metrics[0].metric;
  }
  chartState.set(s.id, state);

  const violatedMetrics = new Set(
    (s.violations || []).map((v) => {
      const m = /\/ (\S+):/.exec(v || '');
      return m ? m[1] : null;
    }).filter(Boolean)
  );

  const chips = s.metrics.map((m) =>
    el('button', {
      class: `metric-chip ${state.metric === m.metric ? 'selected' : ''} ${violatedMetrics.has(m.metric) ? 'violated' : ''}`,
      onclick: () => { state.metric = m.metric; refreshCard(s.id); },
      title: `Ostatni pomiar: ${fmtDate(m.measured_at)}`,
    }, m.metric, el('b', {}, fmtNum(m.value))),
  );

  const ranges = [[6, '6 h'], [24, '24 h'], [24 * 7, '7 dni'], [24 * 30, '30 dni']];

  const card = el('div', { class: `card ${st.cls === 'bad' ? 'alerting' : ''}`, id: `card-${s.id}` },
    el('div', { class: 'card-head' },
      el('span', { class: `dot ${st.cls}` }),
      el('h3', {}, s.label),
      el('span', { class: `status-pill ${st.cls}` }, st.txt)),
    el('div', { class: 'card-sub' },
      `Ostatnie dane: ${fmtAge(s.dataAgeMinutes)} · limit braku danych: ${s.staleMinutes} min`),
    s.alert === 'stale' ? el('div', { class: 'card-alert' }, `🚨 Brak danych od ponad ${s.staleMinutes} min — wysłano alert e-mail.`) : null,
    (s.violations || []).map((v) => el('div', { class: 'card-alert' }, `🚨 ${v}`)),
    s.lastError ? el('div', { class: 'card-error' }, `⚠️ Błąd pobierania: ${s.lastError} (${fmtDate(s.lastCheckedAt)})`) : null,
    el('div', { class: 'metric-chips' }, chips),
    s.metrics.length
      ? el('div', { class: 'chart-wrap' }, el('canvas', { id: `chart-${s.id}` }))
      : el('div', { class: 'empty-chart' }, 'Brak odczytów — wykres pojawi się po pierwszych danych.'),
    el('div', { class: 'chart-toolbar' },
      s.metrics.length ? el('div', { class: 'range-group' },
        ranges.map(([h, label]) => el('button', {
          class: state.hours === h ? 'active' : '',
          onclick: () => { state.hours = h; refreshCard(s.id); },
        }, label))) : null,
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn ghost sm', onclick: () => editSensorDialog(s) }, '⚙ Ustawienia'),
    ),
    el('details', { class: 'rawbox', style: 'margin-top:10px' },
      el('summary', {}, 'Podgląd surowej odpowiedzi API'),
      el('pre', { class: 'raw-pre', id: `raw-${s.id}` }, 'Ładowanie…'),
    ),
  );

  card.querySelector('details.rawbox').addEventListener('toggle', async (e) => {
    if (!e.target.open) return;
    const raw = await api(`/api/sensors/${s.id}/raw`).catch(() => null);
    $(`#raw-${s.id}`).textContent = raw && raw.last_payload
      ? raw.last_payload
      : `Brak zapisanej odpowiedzi.${raw && raw.last_error ? ` Ostatni błąd: ${raw.last_error}` : ''}`;
  });

  if (s.metrics.length) queueMicrotask(() => drawChart(s.id));
  return card;
}

function refreshCard(sensorId) {
  const s = sensorsCache.find((x) => x.id === sensorId);
  if (!s) return;
  const old = $(`#card-${sensorId}`);
  const state = chartState.get(sensorId);
  if (state && state.chart) { state.chart.destroy(); state.chart = null; }
  old.replaceWith(sensorCard(s));
}

async function drawChart(sensorId) {
  const state = chartState.get(sensorId);
  const canvas = $(`#chart-${sensorId}`);
  if (!state || !state.metric || !canvas) return;

  const { rows } = await api(
    `/api/sensors/${sensorId}/history?metric=${encodeURIComponent(state.metric)}&hours=${state.hours}`
  ).catch(() => ({ rows: [] }));

  const longRange = state.hours > 24;
  const labelFmt = new Intl.DateTimeFormat('pl-PL',
    longRange ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
              : { hour: '2-digit', minute: '2-digit' });

  const points = rows.map((r) => ({ x: new Date(r.measured_at).getTime(), y: r.value }));

  const accent = cssVar('--accent');
  const grid = cssVar('--grid');
  const mutedInk = cssVar('--muted');

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [{
        label: state.metric,
        data: points,
        borderColor: accent,
        backgroundColor: accent + '22',
        borderWidth: 2,
        pointRadius: points.length > 80 ? 0 : 2.5,
        pointHoverRadius: 5,
        pointBackgroundColor: accent,
        fill: true,
        tension: 0.25,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => fmtDate(new Date(items[0].parsed.x).toISOString()),
            label: (item) => `${state.metric}: ${fmtNum(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          grid: { display: false },
          border: { color: cssVar('--baseline') },
          ticks: {
            color: mutedInk, maxTicksLimit: 6, font: { size: 11 },
            callback: (v) => labelFmt.format(new Date(v)),
          },
        },
        y: {
          grid: { color: grid },
          border: { display: false },
          ticks: { color: mutedInk, maxTicksLimit: 5, font: { size: 11 } },
        },
      },
    },
  });
}

function editSensorDialog(s) {
  const label = prompt('Nazwa sondy:', s.label);
  if (label === null) return;
  const stale = prompt('Po ilu minutach bez danych wysłać alert?', s.staleMinutes);
  if (stale === null) return;
  api(`/api/sensors/${s.id}`, {
    method: 'PUT',
    body: { label, staleMinutes: parseInt(stale, 10), enabled: s.enabled },
  }).then(() => { toast('Zapisano ustawienia sondy'); loadDashboard(); })
    .catch((e) => toast(e.message, true));
}

/* ================= Reguły ================= */

let editingRuleId = null;

async function loadRules() {
  const [{ rules }, overview] = await Promise.all([
    api('/api/rules'),
    api('/api/overview'),
  ]).catch((e) => { toast(e.message, true); return [{ rules: [] }, null]; });
  if (overview) sensorsCache = overview.sensors;

  const select = $('#ruleSensor');
  select.replaceChildren(...sensorsCache.map((s) => el('option', { value: s.id }, s.label)));
  updateMetricDatalist();

  const body = $('#rulesBody');
  body.replaceChildren();
  if (rules.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: 6, class: 'muted', style: 'text-align:center;padding:28px' },
      'Nie ma jeszcze żadnych reguł. Dodaj pierwszą powyżej.')));
    return;
  }
  for (const r of rules) {
    const range = [
      r.min_value !== null ? `min ${fmtNum(r.min_value)}` : null,
      r.max_value !== null ? `max ${fmtNum(r.max_value)}` : null,
    ].filter(Boolean).join(' · ');
    body.append(el('tr', {},
      el('td', {}, r.sensor_label),
      el('td', {}, el('span', { class: 'mono' }, r.metric)),
      el('td', {}, range),
      el('td', {}, r.alert_active
        ? el('span', { class: 'tag threshold' }, 'ALARM')
        : el('span', { class: 'tag end' }, 'w normie')),
      el('td', {}, r.enabled
        ? el('span', { class: 'tag on' }, 'włączona')
        : el('span', { class: 'tag off-t' }, 'wyłączona')),
      el('td', { style: 'white-space:nowrap;text-align:right' },
        el('button', { class: 'btn ghost sm', onclick: () => startEditRule(r) }, 'Edytuj'),
        ' ',
        el('button', {
          class: 'btn ghost sm',
          onclick: () => toggleRule(r),
        }, r.enabled ? 'Wyłącz' : 'Włącz'),
        ' ',
        el('button', { class: 'btn danger sm', onclick: () => deleteRule(r) }, 'Usuń')),
    ));
  }
}

function updateMetricDatalist() {
  const sensorId = parseInt($('#ruleSensor').value, 10);
  if (!sensorId) return;
  api(`/api/sensors/${sensorId}/metrics`).then(({ metrics }) => {
    $('#metricList').replaceChildren(...metrics.map((m) => el('option', { value: m })));
  }).catch(() => {});
}

function startEditRule(r) {
  editingRuleId = r.id;
  $('#ruleFormTitle').textContent = `Edycja reguły: ${r.sensor_label} / ${r.metric}`;
  $('#ruleSensor').value = r.sensor_id;
  $('#ruleMetric').value = r.metric;
  $('#ruleMin').value = r.min_value ?? '';
  $('#ruleMax').value = r.max_value ?? '';
  $('#ruleSubmit').textContent = 'Zapisz zmiany';
  $('#ruleCancel').hidden = false;
  updateMetricDatalist();
  $('#ruleForm').scrollIntoView({ behavior: 'smooth' });
}

function resetRuleForm() {
  editingRuleId = null;
  $('#ruleFormTitle').textContent = 'Nowa reguła';
  $('#ruleForm').reset();
  $('#ruleSubmit').textContent = 'Dodaj regułę';
  $('#ruleCancel').hidden = true;
}

async function toggleRule(r) {
  await api(`/api/rules/${r.id}`, {
    method: 'PUT',
    body: { sensorId: r.sensor_id, metric: r.metric, min: r.min_value, max: r.max_value, enabled: !r.enabled },
  }).catch((e) => toast(e.message, true));
  loadRules();
}

async function deleteRule(r) {
  if (!confirm(`Usunąć regułę ${r.sensor_label} / ${r.metric}?`)) return;
  await api(`/api/rules/${r.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, true));
  toast('Usunięto regułę');
  loadRules();
}

/* ================= Alerty ================= */

async function loadAlerts() {
  const { log, active } = await api('/api/alerts').catch((e) => { toast(e.message, true); return { log: [], active: [] }; });

  const box = $('#activeAlerts');
  box.replaceChildren();
  if (active.length) {
    for (const a of active) {
      box.append(el('div', { class: 'banner crit' }, '🚨 ', el('div', {},
        el('b', {}, a.detail || a.key),
        el('div', { class: 'muted', style: 'font-size:12.5px' }, `od ${fmtDate(a.since)}`))));
    }
  } else {
    box.append(el('div', { class: 'banner', style: 'background:var(--good-bg);border:1px solid color-mix(in srgb, var(--good) 30%, transparent)' },
      '✅ ', el('div', {}, 'Brak aktywnych alertów — wszystko w normie.')));
  }

  const typeTag = { stale: ['stale', 'brak danych'], threshold: ['threshold', 'próg'] };
  const eventTag = { start: ['start', 'ALARM'], end: ['end', 'powrót do normy'], reminder: ['reminder', 'przypomnienie'] };
  const body = $('#alertsBody');
  body.replaceChildren();
  if (log.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: 6, class: 'muted', style: 'text-align:center;padding:28px' },
      'Historia jest pusta.')));
    return;
  }
  for (const a of log) {
    const [tCls, tTxt] = typeTag[a.type] || ['stale', a.type];
    const [eCls, eTxt] = eventTag[a.event] || ['start', a.event];
    body.append(el('tr', {},
      el('td', { class: 'mono', style: 'white-space:nowrap' }, fmtDate(a.created_at)),
      el('td', {}, a.sensor_key),
      el('td', {}, el('span', { class: `tag ${tCls}` }, tTxt)),
      el('td', {}, el('span', { class: `tag ${eCls}` }, eTxt)),
      el('td', {}, a.message),
      el('td', {}, a.email_sent
        ? el('span', { class: 'tag on' }, 'wysłany')
        : el('span', { class: 'tag off-t', title: a.email_error || '' }, a.email_error ? 'błąd' : 'pominięty')),
    ));
  }
}

/* ================= Ustawienia ================= */

async function loadSettings() {
  const s = await api('/api/settings').catch((e) => { toast(e.message, true); return null; });
  if (!s) return;
  $('#alertEmails').value = s.alertEmails;
  $('#reminderMinutes').value = s.reminderMinutes;
  $('#timezone').value = s.timezone;
  const warnBox = $('#smtpWarning');
  warnBox.replaceChildren();
  if (!s.smtpConfigured) {
    warnBox.append(el('div', { class: 'banner warn' }, '⚠️ ',
      el('div', {}, 'SMTP nie jest skonfigurowany — e-maile nie będą wysyłane. Ustaw zmienne SMTP_HOST, SMTP_USER, SMTP_PASS w Railway.')));
  }
}

/* ================= Inicjalizacja ================= */

async function init() {
  const me = await api('/api/me').catch(() => null);
  if (me) $('#userEmail').textContent = me.email;

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    location.href = '/login';
  });

  $('#ruleSensor').addEventListener('change', updateMetricDatalist);
  $('#ruleCancel').addEventListener('click', resetRuleForm);

  $('#ruleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      sensorId: parseInt($('#ruleSensor').value, 10),
      metric: $('#ruleMetric').value.trim(),
      min: $('#ruleMin').value === '' ? null : Number($('#ruleMin').value),
      max: $('#ruleMax').value === '' ? null : Number($('#ruleMax').value),
      enabled: true,
    };
    try {
      if (editingRuleId) {
        await api(`/api/rules/${editingRuleId}`, { method: 'PUT', body });
        toast('Zapisano regułę');
      } else {
        await api('/api/rules', { method: 'POST', body });
        toast('Dodano regułę');
      }
      resetRuleForm();
      loadRules();
    } catch (err) { toast(err.message, true); }
  });

  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: {
          alertEmails: $('#alertEmails').value,
          reminderMinutes: parseInt($('#reminderMinutes').value, 10) || 0,
          timezone: $('#timezone').value.trim() || 'Europe/Warsaw',
        },
      });
      toast('Zapisano ustawienia');
    } catch (err) { toast(err.message, true); }
  });

  $('#testEmailBtn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/test-email', { method: 'POST', body: {} });
      toast('Wysłano testowy e-mail');
    } catch (err) { toast(err.message, true); }
    e.target.disabled = false;
  });

  $('#pollNowBtn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/poll-now', { method: 'POST', body: {} });
      toast('Sprawdzono sondy');
      if (currentView() === 'pulpit') loadDashboard();
    } catch (err) { toast(err.message, true); }
    e.target.disabled = false;
  });

  $('#passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/change-password', {
        method: 'POST',
        body: {
          currentPassword: $('#currentPassword').value,
          newPassword: $('#newPassword').value,
        },
      });
      toast('Hasło zostało zmienione');
      $('#passwordForm').reset();
    } catch (err) { toast(err.message, true); }
  });

  renderRoute();
  // automatyczne odświeżanie pulpitu
  setInterval(() => { if (currentView() === 'pulpit') loadDashboard(); }, 60000);
}

init();
