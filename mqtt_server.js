// Simple MQTT broker with HTTP helper API using Aedes + Express
// Run: npm i aedes express body-parser

const aedes = require('aedes')();
const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');

const MQTT_PORT = process.env.MQTT_PORT ? parseInt(process.env.MQTT_PORT, 10) : 1883;
const HTTP_PORT = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : 3000;

// Stockage en mémoire des dernières valeurs de capteurs
// Format: { "A1B2C3": { value: 22.5, time: timestamp }, ... }
let sensorsState = {};
const fs = require('fs');
const path = require('path');

const sensorsStatePath = path.join(__dirname, 'logs/sensors_state.json');
// Historique en append (1 JSON par ligne = NDJSON)
const sensorsHistoryPath = path.join(__dirname, 'logs/sensors_history.ndjson');
// Assure que le dossier logs existe (sinon writeFileSync échoue)
try {
  fs.mkdirSync(path.dirname(sensorsStatePath), { recursive: true });
} catch (e) {
  console.error('[SENSOR] Erreur création dossier logs:', e && e.message ? e.message : e);
}
if (fs.existsSync(sensorsStatePath)) {
  try {
    sensorsState = JSON.parse(fs.readFileSync(sensorsStatePath, 'utf8'));
  } catch (e) {
    console.error('[SENSOR] Erreur lecture/parsing sensors_state.json, reset:', e.message);
    sensorsState = {};
  }
}


// TCP MQTT server
const mqttServer = net.createServer(aedes.handle);
mqttServer.on('error', (err) => {
  console.error('[MQTT] TCP server error:', err);
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

// Extra diagnostics
aedes.on('clientError', function (client, err) {
  console.error(`[MQTT] client error (${client ? client.id : 'unknown'}):`, err && err.message ? err.message : err);
});

aedes.on('connectionError', function (client, err) {
  console.error(`[MQTT] connection error (${client ? client.id : 'unknown'}):`, err && err.message ? err.message : err);
});

aedes.on('publish', function (packet, client) {
  if (client) {
    const topic = packet.topic;
    const payloadStr = packet.payload.toString();
    
    // Log générique
    console.log(`[MQTT] ${client.id} -> ${topic}: ${payloadStr}`);

    // Traitement spécifique pour les capteurs de température
    // Topic attendu: sensor/temp/XXXXXX
    if (topic.startsWith('sensor/temp/')) {
      try {
        const data = JSON.parse(payloadStr);
        // L'ID est la dernière partie du topic (ou présent dans le JSON)
        const deviceId = topic.split('/').pop(); 
        
        if (data.value !== null && data.value !== undefined) {
          const reading = {
            value: data.value,
            unit: data.unit || 'C',
            lastUpdate: new Date().toISOString()
          };
          sensorsState[deviceId] = reading;
          console.log(`[SENSOR] Mise à jour ${deviceId} : ${reading.value}°${reading.unit}`);
          try {
            // Snapshot JSON lisible (overwrite)
            fs.writeFileSync(sensorsStatePath, JSON.stringify(sensorsState, null, 2));

            // Historique append (NDJSON): une mesure par ligne
            const event = {
              deviceId,
              ...reading
            };
            fs.writeFileSync(sensorsHistoryPath, `${JSON.stringify(event)}\n`, { flag: 'a' });
          } catch (e) {
            console.error('[SENSOR] Erreur writing to file:', e.message);
          }
        }
      } catch (e) {
        console.error('[SENSOR] Erreur parsing JSON:', e.message);
      }
    }
  }
});

// HTTP helper API to publish messages easily from shell/curl
const app = express();
app.use(bodyParser.json());

function normalizeHexColor(input) {
  if (typeof input !== 'string') return null;
  let c = input.trim().toUpperCase();
  if (c.startsWith('#')) c = c.slice(1);
  // allow 6 hex chars only
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
const HISTORY_MAX_POINTS = 400;
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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function resolveHistoryWindow(req) {
  const daysRaw = req.query.days;
  if (daysRaw !== undefined && daysRaw !== null && String(daysRaw).trim() !== '') {
    const days = clampInt(daysRaw, 1, HISTORY_MAX_DAYS, NaN);
    if (!Number.isFinite(days)) return { error: `invalid days (1-${HISTORY_MAX_DAYS})` };
    return { rangeMs: days * 24 * 60 * 60 * 1000, range: `${days}d`, days };
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
  if (!raw || raw === 'all') return null; // tous les capteurs
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/** Lit le NDJSON une fois: séries + moyennes journalières */
function readHistoryBundle(deviceFilter, sinceMs) {
  return new Promise(function (resolve, reject) {
    if (!fs.existsSync(sensorsHistoryPath)) {
      resolve({ byDevice: {}, dailyAcc: {} });
      return;
    }
    /** @type {Record<string, { t: number, v: number }[]>} */
    const byDevice = {};
    /** @type {Record<string, Record<string, { sum: number, n: number }>>} */
    const dailyAcc = {};
    const stream = fs.createReadStream(sensorsHistoryPath, { encoding: 'utf8' });
    const rl = require('readline').createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', function (line) {
      if (!line) return;
      try {
        const row = JSON.parse(line);
        const deviceId = row.deviceId;
        if (!deviceId) return;
        if (deviceFilter && !deviceFilter.has(deviceId)) return;
        const t = Date.parse(row.lastUpdate);
        if (!Number.isFinite(t) || t < sinceMs) return;
        if (row.value === null || row.value === undefined) return;
        const v = Number(row.value);
        if (!Number.isFinite(v)) return;

        if (!byDevice[deviceId]) byDevice[deviceId] = [];
        byDevice[deviceId].push({ t, v });

        const day = localDayKey(t);
        if (!dailyAcc[day]) dailyAcc[day] = {};
        if (!dailyAcc[day][deviceId]) dailyAcc[day][deviceId] = { sum: 0, n: 0 };
        dailyAcc[day][deviceId].sum += v;
        dailyAcc[day][deviceId].n += 1;
      } catch (_) {
        // ligne corrompue: ignore
      }
    });
    rl.on('close', function () {
      resolve({ byDevice, dailyAcc });
    });
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

function buildDailyRows(dailyAcc) {
  return Object.keys(dailyAcc)
    .sort(function (a, b) {
      return a < b ? 1 : a > b ? -1 : 0;
    })
    .map(function (date) {
      const averages = {};
      const devices = dailyAcc[date];
      for (const id of Object.keys(devices)) {
        const { sum, n } = devices[id];
        averages[id] = Math.round((sum / n) * 100) / 100;
      }
      return { date, averages };
    });
}

// Dernières valeurs connues
app.get('/temperatures', function (req, res) {
  res.json(sensorsState);
});

// Historique: ?range=1h|1d|1w|1m|3m  OU  ?days=N
// deviceId=id  |  deviceId=id1,id2  |  deviceId=all
app.get('/temperatures/history', async function (req, res) {
  const window = resolveHistoryWindow(req);
  if (window.error) return res.status(400).json({ error: window.error });

  const deviceFilter = parseDeviceFilter(req);
  const to = Date.now();
  const from = to - window.rangeMs;

  try {
    const { byDevice, dailyAcc } = await readHistoryBundle(deviceFilter, from);
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
      daily: buildDailyRows(dailyAcc)
    });
  } catch (e) {
    console.error('[SENSOR] history read error:', e && e.message ? e.message : e);
    res.status(500).json({ error: e && e.message ? e.message : 'history read failed' });
  }
});

// Unified command endpoints
// Message command: { mode: "messages", text: string, color?: "#RRGGBB", brightness?: 0-255, speed?: ms }
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

// Conway command: { mode: "conway", color?: "#RRGGBB", brightness?: 0-255, refreshMs?: ms }
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

// Frontend Svelte (build: npm run build --prefix web)
const webDist = path.join(__dirname, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback (après les routes API)
  app.get('*', function (req, res) {
    res.sendFile(path.join(webDist, 'index.html'));
  });
  console.log(`[HTTP] serving web UI from ${webDist}`);
} else {
  console.warn(`[HTTP] web UI not found (${webDist}). Run: npm run build --prefix web`);
}

app.listen(HTTP_PORT, '0.0.0.0', function () {
  console.log(`[HTTP] listening on 0.0.0.0:${HTTP_PORT}`);
});
