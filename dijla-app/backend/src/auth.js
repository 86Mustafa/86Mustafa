'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { HttpError } = require('./errors');
const { hasPermission, permissionsFor, ROLE_LABELS } = require('./permissions');

const COOKIE_NAME = 'dijla_session';
const BCRYPT_ROUNDS = 12;

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);
const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

// هاش ثابت نقارن به عند عدم وجود المستخدم حتى يستغرق الرد نفس الوقت (لا يكشف وجود اسم المستخدم)
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

function generatePassword(length = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role] || u.role,
    active: Boolean(u.active),
    mustChangePassword: Boolean(u.must_change_password),
    permissions: permissionsFor(u.role),
    createdAt: u.created_at,
  };
}

function createAuth({ db, config }) {
  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');

  function issueSession(res, user) {
    const token = jwt.sign({ sub: user.id, tv: user.token_version }, config.jwtSecret, {
      expiresIn: `${config.sessionHours}h`,
      algorithm: 'HS256',
    });
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,            // لا يمكن لجافاسكربت قراءته، فلا تسرقه ثغرات XSS
      sameSite: 'strict',        // يمنع إرساله من مواقع أخرى (حماية CSRF)
      secure: config.cookieSecure,
      maxAge: config.sessionHours * 3600 * 1000,
      path: '/',
    });
  }

  function clearSession(res) {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/' });
  }

  /** يتحقق من الجلسة ويحمّل المستخدم من قاعدة البيانات في كل طلب (فيُطبَّق التعطيل وتغيير الدور فوراً). */
  function requireAuth(req, res, next) {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) return next(new HttpError(401, 'يجب تسجيل الدخول'));
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      clearSession(res);
      return next(new HttpError(401, 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً'));
    }
    const user = getUser.get(payload.sub);
    if (!user || !user.active || user.token_version !== payload.tv) {
      clearSession(res);
      return next(new HttpError(401, 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً'));
    }
    req.user = user;
    next();
  }

  /** يمنع كل العمليات (عدا تغيير كلمة المرور والخروج) حتى يغيّر المستخدم كلمة المرور المؤقتة. */
  function requirePasswordChanged(req, res, next) {
    if (req.user && req.user.must_change_password) {
      return next(new HttpError(403, 'يجب تغيير كلمة المرور المؤقتة أولاً'));
    }
    next();
  }

  const requirePermission = (permission) => (req, res, next) => {
    if (!hasPermission(req.user, permission)) {
      return next(new HttpError(403, 'ليس لديك صلاحية لهذه العملية'));
    }
    next();
  };

  return { issueSession, clearSession, requireAuth, requirePasswordChanged, requirePermission };
}

/**
 * عند أول تشغيل (لا يوجد مستخدمون) ننشئ حساب مدير.
 * كلمة المرور من ADMIN_PASSWORD إن وُجدت، وإلا تُولَّد عشوائياً وتُطبع في السجل مرة واحدة ويُطلب تغييرها.
 */
function ensureInitialAdmin(db, config, logger = console) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return null;
  const generated = !config.adminPassword;
  const password = config.adminPassword || generatePassword();
  db.prepare(`INSERT INTO users (username, display_name, password_hash, role, must_change_password)
              VALUES (?, ?, ?, 'admin', 1)`)
    .run(config.adminUsername, 'مدير النظام', bcrypt.hashSync(password, BCRYPT_ROUNDS));
  logger.log('='.repeat(60));
  logger.log('تم إنشاء حساب المدير الأول:');
  logger.log(`  اسم المستخدم: ${config.adminUsername}`);
  if (generated) logger.log(`  كلمة المرور المؤقتة: ${password}`);
  else logger.log('  كلمة المرور: القيمة الموجودة في ADMIN_PASSWORD');
  logger.log('سيُطلب تغيير كلمة المرور عند أول دخول.');
  logger.log('='.repeat(60));
  return { username: config.adminUsername, password, generated };
}

module.exports = {
  COOKIE_NAME, DUMMY_HASH, createAuth, ensureInitialAdmin,
  hashPassword, verifyPassword, generatePassword, publicUser,
};
