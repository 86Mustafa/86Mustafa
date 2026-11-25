'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * ترحيلات قاعدة البيانات بالترتيب. لا تعدّل ترحيلاً قديماً بعد نشره؛ أضف ترحيلاً جديداً في نهاية المصفوفة.
 * رقم الترحيل الحالي محفوظ في PRAGMA user_version.
 */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    username             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name         TEXT    NOT NULL,
    password_hash        TEXT    NOT NULL,
    role                 TEXT    NOT NULL CHECK (role IN ('admin', 'manager', 'cashier')),
    active               INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    token_version        INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE products (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    type       TEXT    NOT NULL DEFAULT '',
    price      REAL    NOT NULL CHECK (price >= 0),
    stock      INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    image      TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    pharmacy       TEXT    NOT NULL,
    notes          TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'returned')),
    order_date     TEXT    NOT NULL,            -- YYYY-MM-DD بالتوقيت المحلي
    completed_date TEXT,
    returned_date  TEXT,
    total          REAL    NOT NULL DEFAULT 0,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX idx_orders_status ON orders(status);
  CREATE INDEX idx_orders_date   ON orders(order_date);

  -- نحفظ اسم الصنف وسعره وقت الطلب حتى لا تتغير الفواتير القديمة عند تعديل الدواء
  CREATE TABLE order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    name       TEXT    NOT NULL,
    type       TEXT    NOT NULL DEFAULT '',
    price      REAL    NOT NULL CHECK (price >= 0),
    quantity   INTEGER NOT NULL CHECK (quantity > 0)
  );
  CREATE INDEX idx_order_items_order ON order_items(order_id);
  `,
];

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

module.exports = { openDatabase };
