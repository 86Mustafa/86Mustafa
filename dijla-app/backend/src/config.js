'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BACKEND_DIR = path.join(__dirname, '..');

function resolveFromBackend(p) {
  return path.isAbsolute(p) ? p : path.join(BACKEND_DIR, p);
}

const dataDir = resolveFromBackend(process.env.DATA_DIR || 'data');

/**
 * سر توقيع رموز الدخول. إن لم يُحدَّد في .env نولّده مرة واحدة ونحفظه في مجلد البيانات
 * حتى لا تنتهي جلسات المستخدمين عند كل إعادة تشغيل.
 */
function loadJwtSecret(dir) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.jwt-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function buildConfig(overrides = {}) {
  const dir = overrides.dataDir || dataDir;
  return {
    port: Number(process.env.PORT) || 3001,
    host: process.env.HOST || '0.0.0.0',
    dataDir: dir,
    dbPath: overrides.dbPath || resolveFromBackend(process.env.DB_PATH || path.join(dir, 'dijla.db')),
    uploadsDir: overrides.uploadsDir || path.join(dir, 'uploads'),
    publicDir: path.join(BACKEND_DIR, '..', 'public'),
    jwtSecret: overrides.jwtSecret || loadJwtSecret(dir),
    sessionHours: Number(process.env.SESSION_HOURS) || 12,
    // اجعلها true فقط عند التشغيل خلف HTTPS، وإلا لن يحفظ المتصفح ملف تعريف الجلسة
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    // المنطقة الزمنية المستخدمة لتاريخ الطلبات (YYYY-MM-DD)
    timeZone: process.env.APP_TIMEZONE || 'Asia/Baghdad',
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    trustProxy: process.env.TRUST_PROXY === 'true',
    ...overrides,
  };
}

module.exports = { buildConfig };
