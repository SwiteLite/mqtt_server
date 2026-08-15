// Process 2 — Site web + cache températures + historique
// S'abonne au broker MQTT (process broker.js / PM2 mqtt-broker)

const mqtt = require('mqtt');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
const MQTT_PORT = process.env.MQTT_PORT ? parseInt(process.env.MQTT_PORT, 10) : 1883;
const HTTP_PORT = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : 3000;

const logsDir = path.join(__dirname, 'logs');
const historyDir = path.join(logsDir, 'history');
const sensorsStatePath = path.join(logsDir, 'sensors_state.json');
const sensorsDailyPath = path.join(logsDir, 'sensors_daily.json');

/** Cache RAM des dernières valeurs */
let sensorsState = {};
/** @type {Record<string, Record<string, { sum: number, n: number, avg: number }>>} */
let sensorsDaily = {};

try {
  fs.mkdirSync(historyDir, { recursive: true });
} catch (e) {
  console.error('[web] Erreur création logs:', e && e.message ? e.message : e);
}

if (fs.existsSync(sensorsStatePath)) {
  try {
    sensorsState = JSON.parse(fs.readFileSync(sensorsStatePath, 'utf8'));
  } catch (e) {
    console.error('[web] Erreur sensors_state.json:', e.message);
    sensorsState = {};
  }
}

if (fs.existsSync(sensorsDailyPath)) {
  try {
    sensorsDaily = JSON.parse(fs.readFileSync(sensorsDailyPath, 'utf8'));
  } catch (e) {
    console.error('[web] Erreur sensors_daily.json:', e.message);
    sensorsDaily = {};
  }
}

let stateDirty = false;
let dailyDirty = false;
let persistTimer = null;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayFilePath(dayKey) {
  return path.join(historyDir, `${dayKey}.ndjson`);
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(function () {
    persistTimer = null;
    if (stateDirty) {
      stateDirty = false;
      fs.writeFile(sensorsStatePath, JSON.stringify(sensorsState), function (err) {
        if (err) console.error('[web] write state:', err.message);
      });
    }
    if (dailyDirty) {
      dailyDirty = false;
      fs.writeFile(sensorsDailyPath, JSON.stringify(sensorsDaily), function (err) {
        if (err) console.error('[web] write daily:', err.message);
      });
    }
  }, 5000);
}

function recordReading(deviceId, value, unit) {
  const lastUpdate = new Date().toISOString();
  const t = Date.parse(lastUpdate);
  const reading = { value, unit: unit || 'C', lastUpdate };
  sensorsState[deviceId] = reading;
  stateDirty = true;

  const day = localDayKey(t);
  if (!sensorsDaily[day]) sensorsDaily[day] = {};
  if (!sensorsDaily[day][deviceId]) sensorsDaily[day][deviceId] = { sum: 0, n: 0, avg: 0 };
  const acc = sensorsDaily[day][deviceId];
  acc.sum += Number(value);
  acc.n += 1;
  acc.avg = Math.round((acc.sum / acc.n) * 100) / 100;
  dailyDirty = true;

  const event = { deviceId, value: reading.value, unit: reading.unit, lastUpdate };
  fs.appendFile(dayFilePath(day), `${JSON.stringify(event)}\n`, function (err) {
    if (err) console.error('[web] append history:', err.message);
  });

  schedulePersist();
}

// --- Client MQTT → broker local ---
const mqttUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
const mqttClient = mqtt.connect(mqttUrl, {
  clientId: 'mqtt-web-' + Math.random().toString(16).slice(2, 10),
  reconnectPeriod: 2000
});

mqttClient.on('connect', () => {
  console.log(`[web] MQTT connected to ${mqttUrl}`);
  mqttClient.subscribe('sensor/temp/#', (err) => {
    if (err) console.error('[web] subscribe error:', err.message);
    else console.log('[web] subscribed sensor/temp/#');
  });
});

mqttClient.on('reconnect', () => {
  console.log('[web] MQTT reconnecting…');
});

mqttClient.on('error', (err) => {
  console.error('[web] MQTT error:', err && err.message ? err.message : err);
});

mqttClient.on('message', (topic, payload) => {
  if (!topic.startsWith('sensor/temp/')) return;
  try {
    const data = JSON.parse(payload.toString());
    const deviceId = topic.split('/').pop();
    if (data.value === null || data.value === undefined) return;
    recordReading(deviceId, data.value, data.unit || 'C');
  } catch (e) {
    console.error('[web] parse sensor payload:', e.message);
  }
});

function mqttPublish(topic, payload, cb) {
  if (!mqttClient.connected) {
    const err = new Error('MQTT not connected');
    if (cb) return cb(err);
    return;
  }
  mqttClient.publish(topic, payload, cb);
}

// --- HTTP ---
const app = express();
app.use(bodyParser.json());

function normalizeHexColor(input) {
  if (typeof input !== 'string') return null;
  let c = input.trim().toUpperCase();
  if (c.startsWith('#')) c = c.slice(1);
  if (!/^[0-9A-F]{6}$/.test(c)) return null;
  return `#${c}`;
}

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

const RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  '3m': 90 * 24 * 60 * 60 * 1000
};
const HISTORY_MAX_POINTS = 300;
const HISTORY_MAX_DAYS = 366;

function downsamplePoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const out = [];
  const bucketSize = points.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucketSize));
    let sumV = 0;
    let sumT = 0;
    let n = 0;
    for (let j = start; j < end && j < points.length; j++) {
      sumV += points[j].v;
      sumT += points[j].t;
      n++;
    }
    if (n) {
      out.push({
        t: Math.round(sumT / n),
        v: Math.round((sumV / n) * 100) / 100
      });
    }
  }
  return out;
}

function resolveHistoryWindow(req) {
  const daysRaw = req.query.days;
  if (daysRaw !== undefined && daysRaw !== null && String(daysRaw).trim() !== '') {
    const days = clampInt(daysRaw, 1, HISTORY_MAX_DAYS, NaN);
    if (!Number.isFinite(days)) return { error: `invalid days (1-${HISTORY_MAX_DAYS})` };
    return { rangeMs: days * 24 * 60 * 60 * 1000, label: `${days}d`, days };
  }
  const range = typeof req.query.range === 'string' ? req.query.range : '1d';
  const rangeMs = RANGE_MS[range];
  if (!rangeMs) {
    return { error: 'invalid range (use 1h, 1d, 1w, 1m, 3m) or days=N' };
  }
  return { rangeMs, label: range, days: null };
}

function parseDeviceFilter(req) {
  const raw = typeof req.query.deviceId === 'string' ? req.query.deviceId : '';
  if (!raw || raw === 'all') return null;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function eachDayKey(fromMs, toMs) {
  const keys = [];
  const d = new Date(fromMs);
  d.setHours(0, 0, 0, 0);
  const end = new Date(toMs);
  end.setHours(23, 59, 59, 999);
  while (d.getTime() <= end.getTime()) {
    keys.push(localDayKey(d.getTime()));
    d.setDate(d.getDate() + 1);
  }
  return keys;
}

function readDayFile(dayKey, deviceFilter, sinceMs, untilMs, byDevice) {
  return new Promise(function (resolve) {
    const file = dayFilePath(dayKey);
    if (!fs.existsSync(file)) {
      resolve();
      return;
    }
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', function (line) {
      if (!line) return;
      try {
        const row = JSON.parse(line);
        const deviceId = row.deviceId;
        if (!deviceId) return;
        if (deviceFilter && !deviceFilter.has(deviceId)) return;
        const t = Date.parse(row.lastUpdate);
        if (!Number.isFinite(t) || t < sinceMs || t > untilMs) return;
        if (row.value === null || row.value === undefined) return;
        const v = Number(row.value);
        if (!Number.isFinite(v)) return;
        if (!byDevice[deviceId]) byDevice[deviceId] = [];
        byDevice[deviceId].push({ t, v });
      } catch (_) {
        // ignore
      }
    });
    rl.on('close', () => resolve());
    rl.on('error', () => resolve());
    stream.on('error', () => resolve());
  });
}

async function readHistoryFromDayFiles(deviceFilter, fromMs, toMs) {
  const byDevice = {};
  for (const day of eachDayKey(fromMs, toMs)) {
    await readDayFile(day, deviceFilter, fromMs, toMs, byDevice);
  }
  return byDevice;
}

function buildDailyRowsFromCache(fromMs, toMs, deviceFilter) {
  const fromDay = localDayKey(fromMs);
  const toDay = localDayKey(toMs);
  const rows = [];
  for (const date of Object.keys(sensorsDaily)) {
    if (date < fromDay || date > toDay) continue;
    const averages = {};
    const devices = sensorsDaily[date] || {};
    for (const id of Object.keys(devices)) {
      if (deviceFilter && !deviceFilter.has(id)) continue;
      averages[id] = devices[id].avg;
    }
    if (Object.keys(averages).length) rows.push({ date, averages });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows;
}

function readSensorsStateFromDisk() {
  if (!fs.existsSync(sensorsStatePath)) return sensorsState;
  try {
    const parsed = JSON.parse(fs.readFileSync(sensorsStatePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      sensorsState = parsed;
    }
  } catch (e) {
    console.error('[web] relecture sensors_state.json:', e.message);
  }
  return sensorsState;
}

function getCurrentSensors() {
  if (!Object.keys(sensorsState).length) readSensorsStateFromDisk();
  return sensorsState;
}

function sendCurrentSensors(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json(getCurrentSensors());
}

app.get('/api/temps', sendCurrentSensors);
app.get('/temperatures', sendCurrentSensors);

async function handleHistory(req, res) {
  const window = resolveHistoryWindow(req);
  if (window.error) return res.status(400).json({ error: window.error });

  const deviceFilter = parseDeviceFilter(req);
  const to = Date.now();
  const from = to - window.rangeMs;

  try {
    const byDevice = await readHistoryFromDayFiles(deviceFilter, from, to);
    const series = {};
    for (const id of Object.keys(byDevice)) {
      series[id] = downsamplePoints(byDevice[id], HISTORY_MAX_POINTS);
    }
    res.json({
      range: window.label,
      days: window.days,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      series,
      daily: buildDailyRowsFromCache(from, to, null),
      current: getCurrentSensors()
    });
  } catch (e) {
    console.error('[web] history read error:', e && e.message ? e.message : e);
    res.status(500).json({ error: e && e.message ? e.message : 'history read failed' });
  }
}

app.get('/api/temps/history', handleHistory);
app.get('/temperatures/history', handleHistory);

app.post('/message_cmd', function (req, res) {
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text) return res.status(400).json({ error: 'missing text' });
  const color = normalizeHexColor(body.color || '#66CCFF') || '#66CCFF';
  const brightness = clampInt(body.brightness, 0, 255, 192);
  const speed = clampInt(body.speed, 1, 2000, 25);
  const payload = JSON.stringify({
    mode: 'messages',
    text,
    color,
    brightness,
    speed
  });
  mqttPublish('panel/message_cmd', payload, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post('/conway_cmd', function (req, res) {
  const body = req.body || {};
  const color = normalizeHexColor(body.color || '#66CCFF') || '#66CCFF';
  const brightness = clampInt(body.brightness, 0, 255, 192);
  const refreshMs = clampInt(body.refreshMs, 10, 10000, 500);
  const payload = JSON.stringify({
    mode: 'conway',
    color,
    brightness,
    refreshMs
  });
  mqttPublish('panel/conway_cmd', payload, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

const webDist = path.join(__dirname, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', function (req, res, next) {
    if (req.path.startsWith('/api') || req.path.startsWith('/temperatures')) {
      return next();
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });
  console.log(`[web] serving UI from ${webDist}`);
} else {
  console.warn(`[web] UI not found (${webDist}). Copie web/dist depuis le PC.`);
}

const httpServer = app.listen(HTTP_PORT, '0.0.0.0', function () {
  const n = Object.keys(sensorsState).length;
  console.log(`[web] HTTP listening on 0.0.0.0:${HTTP_PORT}`);
  console.log(`[web] cache courant: ${n} capteur(s) → ${Object.keys(sensorsState).join(', ') || '(vide)'}`);
});

httpServer.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[web] port ${HTTP_PORT} déjà utilisé`);
  } else {
    console.error('[web] HTTP error:', err);
  }
  process.exit(1);
});
