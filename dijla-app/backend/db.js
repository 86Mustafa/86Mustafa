const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    type TEXT,
    price REAL,
    stock INTEGER,
    image TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pharmacy TEXT,
    date TEXT,
    subtotal REAL,
    tax REAL,
    total REAL,
    status TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    product_id INTEGER,
    name TEXT,
    type TEXT,
    price REAL,
    quantity INTEGER,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  )`);
});

module.exports = db;