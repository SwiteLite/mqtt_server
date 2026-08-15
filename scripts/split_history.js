#!/usr/bin/env node
/**
 * Découpe logs/sensors_history.ndjson (gros fichier) en:
 *   logs/history/YYYY-MM-DD.ndjson
 *   logs/sensors_daily.json
 *
 * À lancer sur le PC (pas sur la BeagleBone).
 * Usage: node scripts/split_history.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const root = path.join(__dirname, '..');
const src = path.join(root, 'logs', 'sensors_history.ndjson');
const historyDir = path.join(root, 'logs', 'history');
const dailyPath = path.join(root, 'logs', 'sensors_daily.json');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

if (!fs.existsSync(src)) {
  console.error('Fichier introuvable:', src);
  process.exit(1);
}

fs.mkdirSync(historyDir, { recursive: true });

/** @type {Record<string, fs.WriteStream>} */
const streams = {};
/** @type {Record<string, Record<string, { sum: number, n: number, avg: number }>>} */
const daily = {};

let lines = 0;
let written = 0;
const t0 = Date.now();

function getStream(day) {
  if (!streams[day]) {
    streams[day] = fs.createWriteStream(path.join(historyDir, `${day}.ndjson`), { flags: 'a' });
  }
  return streams[day];
}

const rl = readline.createInterface({
  input: fs.createReadStream(src, { encoding: 'utf8' }),
  crlfDelay: Infinity
});

rl.on('line', function (line) {
  lines++;
  if (!line) return;
  try {
    const row = JSON.parse(line);
    if (!row.deviceId || row.value === null || row.value === undefined) return;
    const t = Date.parse(row.lastUpdate);
    if (!Number.isFinite(t)) return;
    const v = Number(row.value);
    if (!Number.isFinite(v)) return;

    const day = localDayKey(t);
    getStream(day).write(`${JSON.stringify({
      deviceId: row.deviceId,
      value: v,
      unit: row.unit || 'C',
      lastUpdate: row.lastUpdate
    })}\n`);
    written++;

    if (!daily[day]) daily[day] = {};
    if (!daily[day][row.deviceId]) daily[day][row.deviceId] = { sum: 0, n: 0, avg: 0 };
    const acc = daily[day][row.deviceId];
    acc.sum += v;
    acc.n += 1;
    acc.avg = Math.round((acc.sum / acc.n) * 100) / 100;

    if (lines % 100000 === 0) {
      console.log(`… ${lines} lignes lues, ${written} écrites`);
    }
  } catch (_) {
    // ignore
  }
});

rl.on('close', function () {
  const days = Object.keys(streams);
  let pending = days.length;
  if (!pending) {
    finish();
    return;
  }
  for (const day of days) {
    streams[day].end(function () {
      pending--;
      if (pending === 0) finish();
    });
  }
});

function finish() {
  fs.writeFileSync(dailyPath, JSON.stringify(daily));
  const ms = Date.now() - t0;
  console.log(`OK: ${written}/${lines} lignes → ${Object.keys(streams).length} fichiers jour`);
  console.log(`Daily: ${dailyPath}`);
  console.log(`Durée: ${(ms / 1000).toFixed(1)}s`);
  console.log('Copie vers la BeagleBone: logs/history/ et logs/sensors_daily.json');
}
