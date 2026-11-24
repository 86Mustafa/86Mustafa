const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// simple request logger
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

// Try to use SQLite DB if backend/db.js exists
let useSqlite = false;
let db = null;
try {
  const dbModule = require('./db');
  if (dbModule && dbModule.db) {
    db = dbModule.db;
    useSqlite = true;
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, type TEXT, price REAL, stock INTEGER, image TEXT
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pharmacy TEXT, date TEXT, subtotal REAL, tax REAL, total REAL, status TEXT, items TEXT
      )`);
    });
  }
} catch (e) {
  useSqlite = false;
}

// fallback file-based storage variables & helpers (always defined so routes can use them)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const productsFile = path.join(dataDir, 'products.json');
const ordersFile = path.join(dataDir, 'orders.json');

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    // if file missing or corrupted, return empty array
    return [];
  }
}
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ensure sample data exist for fallback
if (!useSqlite) {
  if (!fs.existsSync(productsFile)) {
    writeJson(productsFile, [
      { id: 1, name: 'باراسيتامول', type: 'مسكن', price: 2500, stock: 50, image: 'https://via.placeholder.com/400x300?text=باراسيتامول' },
      { id: 2, name: 'أموكسيسيلين', type: 'مضاد حيوي', price: 5000, stock: 30, image: 'https://via.placeholder.com/400x300?text=أموكسيسيلين' }
    ]);
  }
  if (!fs.existsSync(ordersFile)) writeJson(ordersFile, []);
}

// --- Products APIs ---
app.get('/api/products', (req, res) => {
  if (useSqlite) {
    db.all('SELECT * FROM products', (err, rows) => {
      if (err) {
        console.error('GET /api/products ERROR:', err);
        return res.status(500).json({ error: err.message, stack: err.stack });
      }
      res.json(rows || []);
    });
  } else {
    try {
      res.json(readJson(productsFile));
    } catch (e) {
      console.error('GET /api/products (file) ERROR:', e);
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  }
});

app.get('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  if (useSqlite) {
    db.get('SELECT * FROM products WHERE id = ?', [id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json(row);
    });
  } else {
    const all = readJson(productsFile);
    const item = all.find(p => p.id === id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  }
});

app.post('/api/products', (req, res) => {
  const { name = '', type = '', price = 0, stock = 0, image = '' } = req.body;
  if (useSqlite) {
    const stmt = db.prepare('INSERT INTO products (name,type,price,stock,image) VALUES (?,?,?,?,?)');
    stmt.run([name, type, price, stock, image], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM products WHERE id = ?', [this.lastID], (e, row) => {
        if (e) return res.status(500).json({ error: e.message });
        res.status(201).json(row);
      });
    });
    stmt.finalize();
  } else {
    try {
      const all = readJson(productsFile);
      const nextId = all.length ? Math.max(...all.map(p => p.id)) + 1 : 1;
      const newP = { id: nextId, name, type, price, stock, image };
      all.push(newP);
      writeJson(productsFile, all);
      res.status(201).json(newP);
    } catch (e) {
      console.error('POST /api/products (file) ERROR:', e);
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  }
});

app.put('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, type, price, stock, image } = req.body;
  if (useSqlite) {
    db.run('UPDATE products SET name=?, type=?, price=?, stock=?, image=? WHERE id=?',
      [name, type, price, stock, image, id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
        db.get('SELECT * FROM products WHERE id = ?', [id], (e, row) => {
          if (e) return res.status(500).json({ error: e.message });
          res.json(row);
        });
      });
  } else {
    try {
      const all = readJson(productsFile);
      const idx = all.findIndex(p => p.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      all[idx] = { ...all[idx], name, type, price, stock, image };
      writeJson(productsFile, all);
      res.json(all[idx]);
    } catch (e) {
      console.error('PUT /api/products (file) ERROR:', e);
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  }
});

app.delete('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  if (useSqlite) {
    db.run('DELETE FROM products WHERE id = ?', [id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true });
    });
  } else {
    try {
      const all = readJson(productsFile);
      const after = all.filter(p => p.id !== id);
      if (after.length === all.length) return res.status(404).json({ error: 'Not found' });
      writeJson(productsFile, after);
      res.json({ success: true });
    } catch (e) {
      console.error('DELETE /api/products (file) ERROR:', e);
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  }
});

// --- Orders APIs ---
app.get('/api/orders', (req, res) => {
  if (useSqlite) {
    db.all('SELECT * FROM orders', (err, rows) => {
      if (err) {
        console.error('GET /api/orders ERROR:', err);
        return res.status(500).json({ error: err.message, stack: err.stack });
      }
      try {
        rows = (rows || []).map(r => ({ ...r, items: JSON.parse(r.items || '[]') }));
        res.json(rows);
      } catch (parseErr) {
        console.error('GET /api/orders PARSE ERROR:', parseErr);
        res.status(500).json({ error: parseErr.message, stack: parseErr.stack });
      }
    });
  } else {
    try {
      res.json(readJson(ordersFile));
    } catch (e) {
      console.error('GET /api/orders (file) ERROR:', e);
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  }
});

app.post('/api/orders', (req, res) => {
  const { pharmacy = '', date = '', subtotal = 0, tax = 0, total = 0, status = 'معلقة', items = [] } = req.body;
  if (useSqlite) {
    const stmt = db.prepare('INSERT INTO orders (pharmacy,date,subtotal,tax,total,status,items) VALUES (?,?,?,?,?,?,?)');
    stmt.run([pharmacy, date, subtotal, tax, total, status, JSON.stringify(items)], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM orders WHERE id = ?', [this.lastID], (e, row) => {
        if (e) return res.status(500).json({ error: e.message });
        row.items = JSON.parse(row.items || '[]');
        // reduce stock best-effort
        if (items && items.length) {
          items.forEach(it => {
            db.run('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?', [it.quantity || 0, it.id], () => {});
          });
        }
        res.status(201).json(row);
      });
    });
    stmt.finalize();
  } else {
    try {
      const all = readJson(ordersFile);
      const productsAll = readJson(productsFile);
      const nextId = all.length ? Math.max(...all.map(o => o.id)) + 1 : 1;
      const newO = { id: nextId, pharmacy, date, subtotal, tax, total, status, items };
      all.push(newO);
      writeJson(ordersFile, all);
      // reduce stock locally
      items.forEach(it => {
        const pIdx = productsAll.findIndex(p => p.id === it.id);
        if (pIdx !== -1) {
          productsAll[pIdx].stock = Math.max(0, (productsAll[pIdx].stock || 0) - (it.quantity || 0));
        }
      });
      writeJson(productsFile, productsAll);
      res.status(201).json(newO);
    } catch (e) {
      console.error('POST /api/orders (file) ERROR:', e);
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  }
});

// health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// global error handler for unexpected errors
app.use((err, req, res, next) => {
  console.error('UNHANDLED ERROR:', err && (err.stack || err.message || err));
  res.status(500).json({ error: err && err.message ? err.message : 'Internal Server Error', stack: err && err.stack ? err.stack : undefined });
});

const PORT = process.env.PORT || 3001;
app.use(express.static(path.join(__dirname, '..')));
app.listen(PORT, () => console.log(`API + static server listening on ${PORT}`));