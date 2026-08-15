// Process 1 — Broker MQTT uniquement (Aedes)
const aedes = require('aedes')();
const net = require('net');

const MQTT_PORT = process.env.MQTT_PORT ? parseInt(process.env.MQTT_PORT, 10) : 1883;

const server = net.createServer(aedes.handle);

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[broker] port ${MQTT_PORT} déjà utilisé`);
  } else {
    console.error('[broker] error:', err);
  }
  process.exit(1);
});

server.listen(MQTT_PORT, '0.0.0.0', () => {
  console.log(`[broker] MQTT listening on 0.0.0.0:${MQTT_PORT}`);
});

aedes.on('client', (client) => {
  console.log(`[broker] connected: ${client ? client.id : 'unknown'}`);
});

aedes.on('clientDisconnect', (client) => {
  console.log(`[broker] disconnected: ${client ? client.id : 'unknown'}`);
});

aedes.on('clientError', (client, err) => {
  console.error(`[broker] client error (${client ? client.id : '?'}):`, err && err.message ? err.message : err);
});

aedes.on('connectionError', (client, err) => {
  console.error(`[broker] connection error (${client ? client.id : '?'}):`, err && err.message ? err.message : err);
});
