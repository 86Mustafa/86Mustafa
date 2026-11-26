'use strict';

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { createAuth } = require('./auth');
const { createImageStore } = require('./images');
const { errorHandler, notFound } = require('./errors');
const { PERMISSIONS: P } = require('./permissions');

function createApp({ db, config, logger = console }) {
  const app = express();
  const auth = createAuth({ db, config });
  const images = createImageStore(config.uploadsDir);
  const deps = { db, config, auth, images };

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // الواجهة الحالية تستخدم سكربت وأنماط مضمّنة (inline)، ومكتبات من cdnjs (الأيقونات و Excel)
        'script-src': ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
        'script-src-attr': ["'unsafe-inline'"],   // أزرار الطباعة في نوافذ الفاتورة والتقرير
        'style-src': ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
        'font-src': ["'self'", 'https://cdnjs.cloudflare.com', 'data:'],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'connect-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        // لا نرقّي الطلبات إلى HTTPS: التطبيق يعمل غالباً عبر http داخل الشبكة المحلية
        'upgrade-insecure-requests': null,
      },
    },
    // HSTS له معنى فقط خلف HTTPS
    strictTransportSecurity: config.cookieSecure,
  }));

  // حد صغير لحجم الطلبات العادية؛ مسار الاستعادة له محلل خاص بحد أكبر (النسخ تحتوي صوراً)
  const smallJson = express.json({ limit: '200kb' });
  app.use((req, res, next) => (req.path === '/api/restore' ? next() : smallJson(req, res, next)));
  app.use(cookieParser());

  // ===== API =====
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', require('./routes/auth')(deps));

  // كل ما بعد هذا يتطلب تسجيل الدخول وتغيير كلمة المرور المؤقتة
  const api = express.Router();
  api.use(auth.requireAuth, auth.requirePasswordChanged);
  api.use('/products', require('./routes/products')(deps));
  api.use('/orders', require('./routes/orders')(deps));
  api.use('/users', auth.requirePermission(P.USERS), require('./routes/users')(deps));
  api.use('/', auth.requirePermission(P.BACKUP), require('./routes/backup')(deps));
  app.use('/api', api);
  app.use('/api', (req, res, next) => next(notFound('المسار غير موجود')));

  // صور الأدوية المرفوعة (للمستخدمين المسجلين فقط)
  app.use('/uploads', auth.requireAuth, express.static(config.uploadsDir, {
    fallthrough: false, index: false, dotfiles: 'deny', maxAge: '7d', immutable: true,
  }));

  // الواجهة: نقدّم مجلد public فقط (لا ملفات الخادم ولا قاعدة البيانات)
  app.use(express.static(config.publicDir, { index: 'index.html', dotfiles: 'deny' }));

  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
