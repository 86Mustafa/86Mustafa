'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { badRequest } = require('../errors');
const { loadOrders } = require('./orders');
const { normalizeDate, localDate } = require('../dates');

// حالات الطلب في النسخ القديمة كانت بالعربية (وبصيغتين: معلق / معلقة)
const STATUS_MAP = {
  pending: 'pending', 'معلق': 'pending', 'معلقة': 'pending',
  completed: 'completed', 'مكتمل': 'completed', 'مكتملة': 'completed',
  returned: 'returned', 'مسترجع': 'returned', 'مسترجعة': 'returned',
};

const MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const str = (v, max) => (v == null ? '' : String(v)).trim().slice(0, max);

module.exports = function backupRoutes({ db, config, images }) {
  const router = express.Router();

  /** يقرأ صورة مرفوعة ويعيدها data URL حتى تكون النسخة الاحتياطية ملفاً واحداً مكتفياً بذاته. */
  function embedImage(url) {
    if (typeof url !== 'string' || !url.startsWith('/uploads/')) return url || '';
    const file = path.join(config.uploadsDir, path.basename(url));
    try {
      const ext = path.extname(file).slice(1);
      return `data:${MIME_BY_EXT[ext] || 'application/octet-stream'};base64,${fs.readFileSync(file).toString('base64')}`;
    } catch {
      return '';
    }
  }

  router.get('/backup', (req, res) => {
    const products = db.prepare('SELECT id, name, type, price, stock, image FROM products ORDER BY id').all()
      .map((p) => ({ ...p, image: embedImage(p.image) }));
    const data = { format: 'dijla-backup', version: 2, timestamp: new Date().toISOString(), products, orders: loadOrders(db) };
    res.setHeader('Content-Disposition', `attachment; filename="backup-${localDate(config.timeZone)}.json"`);
    res.json(data);
  });

  /**
   * استعادة: تستبدل كل الأدوية والطلبات. تقبل نسخ هذا الخادم ونسخ الواجهة القديمة (localStorage)
   * وتحوّل الصور المضمّنة إلى ملفات، والحالات العربية إلى رموز، والتواريخ إلى YYYY-MM-DD.
   * المستخدمون لا يتأثرون بالاستعادة.
   */
  router.post('/restore', express.json({ limit: '60mb' }), (req, res) => {
    const body = req.body;
    if (!body || !Array.isArray(body.products) || !Array.isArray(body.orders)) {
      throw badRequest('ملف النسخة الاحتياطية غير صالح');
    }

    const today = localDate(config.timeZone);
    const seenIds = new Set();
    const products = [];
    for (const p of body.products) {
      if (!p || typeof p !== 'object') continue;
      const id = Math.trunc(num(p.id));
      const name = str(p.name, 120);
      if (id <= 0 || seenIds.has(id) || !name) continue;
      seenIds.add(id);
      products.push({
        id, name,
        type: str(p.type, 50),
        price: Math.max(0, num(p.price)),
        stock: Math.max(0, Math.trunc(num(p.stock))),
        rawImage: typeof p.image === 'string' ? p.image : '',
      });
    }

    const orders = [];
    for (const o of body.orders) {
      if (!o || typeof o !== 'object') continue;
      const items = (Array.isArray(o.items) ? o.items : [])
        .filter((i) => i && typeof i === 'object' && Math.trunc(num(i.quantity)) > 0 && str(i.name, 120))
        .map((i) => {
          const pid = Math.trunc(num(i.id ?? i.productId, 0));
          return {
            productId: seenIds.has(pid) ? pid : null,
            name: str(i.name, 120),
            type: str(i.type, 50),
            price: Math.max(0, num(i.price)),
            quantity: Math.trunc(num(i.quantity)),
          };
        });
      if (items.length === 0) continue;
      const status = STATUS_MAP[str(o.status, 20)] || 'pending';
      orders.push({
        pharmacy: str(o.pharmacy, 120) || 'غير محدد',
        notes: str(o.notes, 1000),
        status,
        date: normalizeDate(o.date) || today,
        completedDate: status === 'completed' || status === 'returned' ? normalizeDate(o.completedDate) : null,
        returnedDate: status === 'returned' ? normalizeDate(o.returnedDate) : null,
        total: items.reduce((s, i) => s + i.price * i.quantity, 0),
        items,
      });
    }

    // الصور تُكتب قبل المعاملة؛ نحذف الجديدة إن فشلت، والقديمة بعد النجاح
    const keepImage = (raw) =>
      raw.startsWith('/uploads/') && fs.existsSync(path.join(config.uploadsDir, path.basename(raw)));
    const newImages = [];
    for (const p of products) {
      if (p.rawImage.startsWith('data:')) {
        p.image = images.saveDataUrl(p.rawImage);
        if (p.image) newImages.push(p.image);
      } else if (/^https?:\/\//i.test(p.rawImage) && !p.rawImage.includes('placeholder.com')) {
        p.image = p.rawImage.slice(0, 2000);
      } else {
        p.image = keepImage(p.rawImage) ? p.rawImage : '';
      }
    }
    const oldImages = db.prepare(`SELECT image FROM products WHERE image LIKE '/uploads/%'`).all().map((r) => r.image);

    try {
      db.transaction(() => {
        db.prepare('DELETE FROM orders').run();      // order_items تُحذف تلقائياً (CASCADE)
        db.prepare('DELETE FROM products').run();
        const insP = db.prepare('INSERT INTO products (id, name, type, price, stock, image) VALUES (?, ?, ?, ?, ?, ?)');
        for (const p of products) insP.run(p.id, p.name, p.type, p.price, p.stock, p.image);
        const insO = db.prepare(`INSERT INTO orders (pharmacy, notes, status, order_date, completed_date, returned_date, total, created_by)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        const insI = db.prepare('INSERT INTO order_items (order_id, product_id, name, type, price, quantity) VALUES (?, ?, ?, ?, ?, ?)');
        for (const o of orders) {
          const { lastInsertRowid } = insO.run(o.pharmacy, o.notes, o.status, o.date, o.completedDate, o.returnedDate, o.total, req.user.id);
          for (const i of o.items) insI.run(lastInsertRowid, i.productId, i.name, i.type, i.price, i.quantity);
        }
      })();
    } catch (err) {
      newImages.forEach(images.remove);
      throw err;
    }

    const stillUsed = new Set(products.map((p) => p.image));
    oldImages.filter((img) => !stillUsed.has(img)).forEach(images.remove);

    res.json({ ok: true, products: products.length, orders: orders.length });
  });

  return router;
};
