'use strict';

const os = require('os');
const { buildConfig } = require('./config');
const { openDatabase } = require('./db');
const { ensureInitialAdmin } = require('./auth');
const { createApp } = require('./app');

const config = buildConfig();
const db = openDatabase(config.dbPath);
ensureInitialAdmin(db, config);

const app = createApp({ db, config });

const server = app.listen(config.port, config.host, () => {
  console.log(`الخادم يعمل على المنفذ ${config.port}`);
  console.log(`  على هذا الجهاز:  http://localhost:${config.port}`);
  // عناوين الشبكة المحلية لفتح التطبيق من الهاتف أو جهاز آخر
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  من الشبكة المحلية: http://${a.address}:${config.port}`);
    }
  }
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
