/**
 * PM2 — 2 process :
 *  - mqtt-broker : Aedes (port 1883)
 *  - mqtt-web    : site + cache + historique (port 3000), client MQTT
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 status
 *   pm2 logs
 *   pm2 restart mqtt-web
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'mqtt-broker',
      script: 'broker.js',
      autorestart: true,
      max_memory_restart: '80M',
      env: {
        MQTT_PORT: 1883
      }
    },
    {
      name: 'mqtt-web',
      script: 'webapp.js',
      autorestart: true,
      max_memory_restart: '180M',
      // laisser le broker démarrer avant le client
      wait_ready: false,
      env: {
        MQTT_HOST: '127.0.0.1',
        MQTT_PORT: 1883,
        HTTP_PORT: 3000
      }
    }
  ]
};
