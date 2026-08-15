// Ancien monolithe — remplacé par broker.js + webapp.js (PM2)
console.error('');
console.error('mqtt_server.js est obsolète.');
console.error('Utilise PM2 avec les 2 process séparés :');
console.error('');
console.error('  npm install');
console.error('  pm2 start ecosystem.config.cjs');
console.error('  pm2 status');
console.error('');
console.error('Ou manuellement :');
console.error('  node broker.js');
console.error('  node webapp.js');
console.error('');
process.exit(1);
