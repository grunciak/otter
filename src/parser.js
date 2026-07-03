'use strict';

// Parser odpowiedzi API sond. Format nie jest z góry znany, więc obsługujemy
// najczęstsze warianty: tablica rekordów, {data:[...]}, {rows:[...]},
// {records:[...]}, pojedynczy obiekt. Pole czasu wykrywamy po nazwie,
// pozostałe pola liczbowe traktujemy jako metryki.

const TIME_FIELDS = [
  'timestamp', 'time', 'datetime', 'date_time', 'created_at', 'createdat',
  'measured_at', 'ts', 'date', 'czas', 'data_pomiaru', 'datum', 'reading_time',
];

function findRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const k of ['data', 'rows', 'records', 'results', 'items', 'readings']) {
      if (Array.isArray(payload[k])) return payload[k];
    }
    // pojedynczy rekord
    if (Object.keys(payload).length > 0) return [payload];
  }
  return [];
}

function parseTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    // sekundy vs milisekundy epoch
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{10}(\.\d+)?$/.test(s)) return new Date(parseFloat(s) * 1000);
  if (/^\d{13}$/.test(s)) return new Date(parseInt(s, 10));
  // 'YYYY-MM-DD HH:MM:SS' → ISO; bez strefy zakładamy UTC
  let iso = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(iso)) iso += 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function timeFieldOf(row) {
  const keys = Object.keys(row);
  const lower = new Map(keys.map((k) => [k.toLowerCase(), k]));
  for (const tf of TIME_FIELDS) {
    if (lower.has(tf)) {
      const key = lower.get(tf);
      if (parseTimestamp(row[key])) return key;
    }
  }
  // fallback: dowolne pole, którego wartość parsuje się jako sensowna data
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v) && parseTimestamp(v)) return k;
  }
  return null;
}

function numericValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim().replace(',', '.');
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  }
  return null;
}

const NON_METRIC_FIELDS = new Set(['id', 'sensor_id', 'device_id', 'row_id', 'lp']);

// Zwraca { rows: [{measuredAt: Date|null, metrics: {name: number}}], latestAt: Date|null }
function parsePayload(payload) {
  const rawRows = findRows(payload);
  const rows = [];
  let latestAt = null;

  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const tf = timeFieldOf(raw);
    const measuredAt = tf ? parseTimestamp(raw[tf]) : null;
    const metrics = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === tf) continue;
      if (NON_METRIC_FIELDS.has(k.toLowerCase())) continue;
      const num = numericValue(v);
      if (num !== null) metrics[k] = num;
    }
    if (Object.keys(metrics).length === 0) continue;
    rows.push({ measuredAt, metrics });
    if (measuredAt && (!latestAt || measuredAt > latestAt)) latestAt = measuredAt;
  }

  return { rows, latestAt };
}

module.exports = { parsePayload, parseTimestamp };
