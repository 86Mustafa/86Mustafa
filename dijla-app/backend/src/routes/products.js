'use strict';

const express = require('express');
const { notFound } = require('../errors');
const { productSchema, idParam } = require('../validation');
const { PERMISSIONS: P } = require('../permissions');

module.exports = function productRoutes({ db, auth, images }) {
  const router = express.Router();

  const listAll = db.prepare('SELECT id, name, type, price, stock, image FROM products ORDER BY name COLLATE NOCASE');
  const getOne = db.prepare('SELECT id, name, type, price, stock, image FROM products WHERE id = ?');

  router.get('/', (req, res) => {
    res.json(listAll.all());
  });

  router.get('/:id', (req, res) => {
    const product = getOne.get(idParam.parse(req.params.id));
    if (!product) throw notFound('الدواء غير موجود');
    res.json(product);
  });

  // الصورة اختيارية وتُرسل في الحقل "image" بصيغة multipart/form-data
  router.post('/', auth.requirePermission(P.PRODUCTS_WRITE), images.single('image'), (req, res) => {
    const data = productSchema.parse(req.body);
    const image = req.file ? images.saveBuffer(req.file.buffer) : '';
    try {
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO products (name, type, price, stock, image) VALUES (?, ?, ?, ?, ?)'
      ).run(data.name, data.type, data.price, data.stock, image);
      res.status(201).json(getOne.get(lastInsertRowid));
    } catch (err) {
      images.remove(image);
      throw err;
    }
  });

  router.put('/:id', auth.requirePermission(P.PRODUCTS_WRITE), images.single('image'), (req, res) => {
    const id = idParam.parse(req.params.id);
    const existing = getOne.get(id);
    if (!existing) throw notFound('الدواء غير موجود');
    const data = productSchema.parse(req.body);
    const image = req.file ? images.saveBuffer(req.file.buffer) : existing.image;
    db.prepare(`UPDATE products SET name = ?, type = ?, price = ?, stock = ?, image = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(data.name, data.type, data.price, data.stock, image, id);
    if (req.file) images.remove(existing.image);
    res.json(getOne.get(id));
  });

  router.delete('/:id', auth.requirePermission(P.PRODUCTS_DELETE), (req, res) => {
    const id = idParam.parse(req.params.id);
    const existing = getOne.get(id);
    if (!existing) throw notFound('الدواء غير موجود');
    // الطلبات القديمة تحتفظ باسم الدواء وسعره (product_id يصبح NULL)
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    images.remove(existing.image);
    res.json({ ok: true });
  });

  return router;
};
