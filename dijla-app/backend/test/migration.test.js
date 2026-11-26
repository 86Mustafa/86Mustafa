'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrate, MIGRATIONS } = require('../src/db');

test('ترحيل قاعدة بيانات المرحلة الثانية: الكمية تصبح دفعة غير محددة', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, 1); // قاعدة بيانات بإصدار المرحلة الثانية
  db.prepare(`INSERT INTO products (id, name, type, price, stock) VALUES (1, 'أ', 'حبوب', 100, 12), (2, 'ب', 'حبوب', 50, 0)`).run();
  db.prepare(`INSERT INTO orders (id, pharmacy, status, order_date, total) VALUES (1, 'ص', 'completed', '2026-01-01', 100)`).run();
  db.prepare(`INSERT INTO order_items (order_id, product_id, name, price, quantity) VALUES (1, 1, 'أ', 100, 1)`).run();

  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
  assert.ok(!db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'stock'), 'عمود stock حُذف');
  assert.deepEqual(db.prepare('SELECT product_id, batch_no, expiry_date, quantity FROM product_batches').all(),
    [{ product_id: 1, batch_no: '', expiry_date: null, quantity: 12 }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_items').get().n, 1, 'الطلبات القديمة سليمة');
  db.close();
});
