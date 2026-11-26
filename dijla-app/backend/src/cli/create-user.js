'use strict';

/**
 * إنشاء مستخدم أو إعادة تعيين كلمة مروره من سطر الأوامر (مفيد إذا نُسيت كلمة مرور المدير).
 *
 *   npm run create-user -- <username> <role> [display name]
 *   الدور: admin | manager | cashier
 *
 * تُطبع كلمة مرور مؤقتة يُطلب تغييرها عند أول دخول.
 */
const { buildConfig } = require('../config');
const { openDatabase } = require('../db');
const { generatePassword } = require('../auth');
const bcrypt = require('bcryptjs');

const [username, role, ...nameParts] = process.argv.slice(2);
if (!username || !['admin', 'manager', 'cashier'].includes(role)) {
  console.error('الاستخدام: npm run create-user -- <username> <admin|manager|cashier> [الاسم]');
  process.exit(1);
}
if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
  console.error('اسم المستخدم: 3-32 حرفاً إنجليزياً أو أرقاماً أو . _ -');
  process.exit(1);
}

const db = openDatabase(buildConfig().dbPath);
const password = generatePassword();
const hash = bcrypt.hashSync(password, 12);
const displayName = nameParts.join(' ') || username;
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

if (existing) {
  db.prepare(`UPDATE users SET password_hash = ?, role = ?, active = 1, must_change_password = 1,
              token_version = token_version + 1 WHERE id = ?`).run(hash, role, existing.id);
  console.log(`تمت إعادة تعيين كلمة مرور المستخدم ${username} وتفعيله بدور ${role}.`);
} else {
  db.prepare(`INSERT INTO users (username, display_name, password_hash, role, must_change_password)
              VALUES (?, ?, ?, ?, 1)`).run(username, displayName, hash, role);
  console.log(`تم إنشاء المستخدم ${username} بدور ${role}.`);
}
console.log(`كلمة المرور المؤقتة: ${password}`);
db.close();
