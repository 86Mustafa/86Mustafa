'use strict';

const express = require('express');
const { notFound, conflict, badRequest } = require('../errors');
const { createUserSchema, updateUserSchema, idParam } = require('../validation');
const { hashPassword, publicUser } = require('../auth');

/** إدارة المستخدمين (للمدير فقط؛ الصلاحية تُفحص عند ربط المسار في app.js). */
module.exports = function userRoutes({ db }) {
  const router = express.Router();

  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const countActiveAdmins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`);

  router.get('/', (req, res) => {
    res.json(db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser));
  });

  router.post('/', async (req, res) => {
    const data = createUserSchema.parse(req.body);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(data.username)) {
      throw conflict('اسم المستخدم مستخدم مسبقاً');
    }
    const hash = await hashPassword(data.password);
    // كلمة المرور التي يضعها المدير مؤقتة: يُطلب من المستخدم تغييرها عند أول دخول
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (username, display_name, password_hash, role, must_change_password)
      VALUES (?, ?, ?, ?, 1)`).run(data.username, data.displayName, hash, data.role);
    res.status(201).json(publicUser(getUser.get(lastInsertRowid)));
  });

  router.patch('/:id', async (req, res) => {
    const id = idParam.parse(req.params.id);
    const data = updateUserSchema.parse(req.body);
    const user = getUser.get(id);
    if (!user) throw notFound('المستخدم غير موجود');

    const losesAdmin = user.role === 'admin' && user.active &&
      ((data.role && data.role !== 'admin') || data.active === false);
    if (losesAdmin && countActiveAdmins.get().n <= 1) {
      throw conflict('لا يمكن إزالة صلاحية آخر مدير نشط في النظام');
    }
    if (id === req.user.id && (data.active === false || (data.role && data.role !== req.user.role))) {
      throw badRequest('لا يمكنك تعطيل حسابك أو تغيير دورك بنفسك');
    }

    const hash = data.password ? await hashPassword(data.password) : null;
    db.transaction(() => {
      if (data.displayName !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(data.displayName, id);
      if (data.role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(data.role, id);
      if (data.active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(data.active ? 1 : 0, id);
      if (hash) {
        db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, id);
      }
      // أي تغيير في الدور أو التعطيل أو كلمة المرور يُنهي جلسات المستخدم الحالية
      if (data.role !== undefined || data.active === false || hash) {
        db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id);
      }
    })();
    res.json(publicUser(getUser.get(id)));
  });

  return router;
};
