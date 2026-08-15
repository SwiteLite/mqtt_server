// MQTT broker (Aedes) + API HTTP + UI températures
// Optimisé BeagleBone: historique par jour (pas de scan du gros NDJSON)

const aedes = require('aedes')();
const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MQTT_PORT = process.env.MQTT_PORT ? parseInt(process.env.MQTT_PORT, 10) : 1883;
const HTTP_PORT = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : 3000;

const logsDir = path.join(__dirname, 'logs');
const historyDir = path.join(logsDir, 'history');
const sensorsStatePath = path.join(logsDir, 'sensors_state.json');
const sensorsDailyPath = path.join(logsDir, 'sensors_daily.json');

let sensorsState = {};
/** @type {Record<string, Record<string, { sum: number, n: number, avg: number }>>} */
let sensorsDaily = {};

try {
  fs.mkdirSync(historyDir, { recursive: true });
} catch (e) {
  console.error('[SENSOR] Erreur création logs:', e && e.message ? e.message : e);
}

if (fs.existsSync(sensorsStatePath)) {
  try {
    sensorsState = JSON.parse(fs.readFileSync(sensorsStatePath, 'utf8'));
  } catch (e) {
    console.error('[SENSOR] Erreur sensors_state.json:', e.message);
    sensorsState = {};
  }
}

if (fs.existsSync(sensorsDailyPath)) {
  try {
    sensorsDaily = JSON.parse(fs.readFileSync(sensorsDailyPath, 'utf8'));
  } catch (e) {
    console.error('[SENSOR] Erreur sensors_daily.json:', e.message);
    sensorsDaily = {};
  }
}

// --- MQTT ---
const mqttServer = net.createServer(aedes.handle);
mqttServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[MQTT] port ${MQTT_PORT} déjà utilisé — arrête l'ancienne instance puis relance.`);
  } else {
    console.error('[MQTT] TCP server error:', err);
  }
  process.exit(1);
});
mqttServer.listen(MQTT_PORT, '0.0.0.0', function () {
  console.log(`[MQTT] broker listening on 0.0.0.0:${MQTT_PORT}`);
});

aedes.on('client', function (client) {
  console.log(`[MQTT] client connected: ${client ? client.id : 'unknown'}`);
});
aedes.on('clientDisconnect', function (client) {
  console.log(`[MQTT] client disconnected: ${client ? client.id : 'unknown'}`);
});
aedes.on('clientError', function (client, err) {
  console.error(`[MQTT] client error (${client ? client.id : 'unknown'}):`, err && err.message ? err.message : err);
});
aedes.on('connectionError', function (client, err) {
  console.error(`[MQTT] connection error (${client ? client.id : 'unknown'}):`, err && err.message ? err.message : err);
});

// --- Persistance légère (async + debounce) ---
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
        if (err) console.error('[SENSOR] write state:', err.message);
      });
    }
    if (dailyDirty) {
      dailyDirty = false;
      fs.writeFile(sensorsDailyPath, JSON.stringify(sensorsDaily), function (err) {
        if (err) console.error('[SENSOR] write daily:', err.message);
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
    if (err) console.error('[SENSOR] append history:', err.message);
  });

  schedulePersist();
}

aedes.on('publish', function (packet, client) {
  if (!client) return;
  const topic = packet.topic;
  if (!topic.startsWith('sensor/temp/')) return;

  try {
    const data = JSON.parse(packet.payload.toString());
    const deviceId = topic.split('/').pop();
    if (data.value === null || data.value === undefined) return;
    recordReading(deviceId, data.value, data.unit || 'C');
  } catch (e) {
    console.error('[SENSOR] Erreur parsing JSON:', e.message);
  }
});

// --- HTTP ---
const app = express();
app.use(bodyParser.json());

function normalizeHexColor(input) {
  if (typeof input !== 'string') return null;
  let c = input.trim().toUpperCase();
  if (c.startsWith('#')) c = c.slice(1);
  const hex6 = /^[0-9A-F]{6}$/;
  if (!hex6.test(c)) return null;
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
    rl.on('close', function () {
      resolve();
    });
    rl.on('error', function () {
      resolve();
    });
    stream.on('error', function () {
      resolve();
    });
  });
}

async function readHistoryFromDayFiles(deviceFilter, fromMs, toMs) {
  const byDevice = {};
  const days = eachDayKey(fromMs, toMs);
  // Séquentiel: plus doux pour la BBB (évite de saturer disque/CPU)
  for (const day of days) {
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
  rows.sort(function (a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });
  return rows;
}

app.get('/temperatures', function (req, res) {
  res.json(sensorsState);
});

// Historique léger: lit seulement logs/history/YYYY-MM-DD.ndjson
app.get('/temperatures/history', async function (req, res) {
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
      daily: buildDailyRowsFromCache(from, to, deviceFilter)
    });
  } catch (e) {
    console.error('[SENSOR] history read error:', e && e.message ? e.message : e);
    res.status(500).json({ error: e && e.message ? e.message : 'history read failed' });
  }
});

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
  aedes.publish({ topic: 'panel/message_cmd', payload }, function (err) {
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
  aedes.publish({ topic: 'panel/conway_cmd', payload }, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

const webDist = path.join(__dirname, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', function (req, res) {
    res.sendFile(path.join(webDist, 'index.html'));
  });
  console.log(`[HTTP] serving web UI from ${webDist}`);
} else {
  console.warn(`[HTTP] web UI not found (${webDist}). Copie web/dist depuis le PC.`);
}

const httpServer = app.listen(HTTP_PORT, '0.0.0.0', function () {
  console.log(`[HTTP] listening on 0.0.0.0:${HTTP_PORT}`);
});
httpServer.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[HTTP] port ${HTTP_PORT} déjà utilisé — arrête l'ancienne instance puis relance.`);
  } else {
    console.error('[HTTP] server error:', err);
  }
  process.exit(1);
});
