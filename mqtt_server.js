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

// --- NOUVELLE ROUTE : Récupérer les températures ---
app.get('/temperatures', function (req, res) {
  res.json(sensorsState);
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
