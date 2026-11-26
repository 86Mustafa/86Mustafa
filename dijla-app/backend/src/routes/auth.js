'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { HttpError, badRequest } = require('../errors');
const { loginSchema, changePasswordSchema } = require('../validation');
const { DUMMY_HASH, hashPassword, verifyPassword, publicUser } = require('../auth');

module.exports = function authRoutes({ db, auth }) {
  const router = express.Router();

  // حماية من تخمين كلمات المرور: 10 محاولات فاشلة لكل 15 دقيقة من نفس العنوان
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'محاولات دخول كثيرة، حاول بعد 15 دقيقة' },
  });

  const findByUsername = db.prepare('SELECT * FROM users WHERE username = ?');

  router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const user = findByUsername.get(username);
    const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok || !user.active) {
      throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    auth.issueSession(res, user);
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    auth.clearSession(res);
    res.json({ ok: true });
  });

  router.get('/me', auth.requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  router.post('/change-password', auth.requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    if (!(await verifyPassword(currentPassword, req.user.password_hash))) {
      throw badRequest('كلمة المرور الحالية غير صحيحة');
    }
    if (currentPassword === newPassword) throw badRequest('كلمة المرور الجديدة يجب أن تختلف عن الحالية');
    const hash = await hashPassword(newPassword);
    // زيادة token_version تُنهي كل الجلسات الأخرى لهذا المستخدم
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1
                WHERE id = ?`).run(hash, req.user.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    auth.issueSession(res, updated);
    res.json({ user: publicUser(updated) });
  });

  return router;
};
