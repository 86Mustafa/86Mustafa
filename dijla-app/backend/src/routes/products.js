'use strict';

const express = require('express');
const { notFound } = require('../errors');
const {
  productSchema, productCreateSchema, batchSchema, batchUpdateSchema, idParam,
} = require('../validation');
const { PERMISSIONS: P } = require('../permissions');
const { localDate } = require('../dates');
const { listProducts, getProduct } = require('../inventory');

module.exports = function productRoutes({ db, auth, images, config }) {
  const router = express.Router();
  const today = () => localDate(config.timeZone);
  const canWrite = auth.requirePermission(P.PRODUCTS_WRITE);

  const findProduct = (id) => {
    const product = getProduct(db, id, today());
    if (!product) throw notFound('الدواء غير موجود');
    return product;
  };

  router.get('/', (req, res) => {
    res.json(listProducts(db, today()));
  });

  router.get('/:id', (req, res) => {
    res.json(findProduct(idParam.parse(req.params.id)));
  });

  // الصورة اختيارية وتُرسل في الحقل "image" بصيغة multipart/form-data.
  // الكمية الأولى (إن وُجدت) تُسجَّل كدفعة برقمها وتاريخ انتهائها.
  router.post('/', canWrite, images.single('image'), (req, res) => {
    const data = productCreateSchema.parse(req.body);
    const image = req.file ? images.saveBuffer(req.file.buffer) : '';
    try {
      const id = db.transaction(() => {
        const { lastInsertRowid } = db.prepare('INSERT INTO products (name, type, price, image) VALUES (?, ?, ?, ?)')
          .run(data.name, data.type, data.price, image);
        if (data.stock > 0) {
          db.prepare('INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity) VALUES (?, ?, ?, ?)')
            .run(lastInsertRowid, data.batchNo, data.expiryDate, data.stock);
        }
        return lastInsertRowid;
      })();
      res.status(201).json(findProduct(id));
    } catch (err) {
      images.remove(image);
      throw err;
    }
  });

  // تعديل بيانات الدواء فقط؛ الكميات تُدار عبر الدفعات
  router.put('/:id', canWrite, images.single('image'), (req, res) => {
    const id = idParam.parse(req.params.id);
    const existing = findProduct(id);
    const data = productSchema.parse(req.body);
    const image = req.file ? images.saveBuffer(req.file.buffer) : existing.image;
    db.prepare(`UPDATE products SET name = ?, type = ?, price = ?, image = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(data.name, data.type, data.price, image, id);
    if (req.file) images.remove(existing.image);
    res.json(findProduct(id));
  });

  router.delete('/:id', auth.requirePermission(P.PRODUCTS_DELETE), (req, res) => {
    const id = idParam.parse(req.params.id);
    const existing = findProduct(id);
    // الطلبات القديمة تحتفظ باسم الدواء وسعره (product_id يصبح NULL)، والدفعات تُحذف معه
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    images.remove(existing.image);
    res.json({ ok: true });
  });

  // ===== الدفعات =====

  router.post('/:id/batches', canWrite, (req, res) => {
    const id = idParam.parse(req.params.id);
    findProduct(id);
    const data = batchSchema.parse(req.body);
    db.prepare('INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity) VALUES (?, ?, ?, ?)')
      .run(id, data.batchNo, data.expiryDate, data.quantity);
    res.status(201).json(findProduct(id));
  });

  const findBatch = (productId, batchId) => {
    const batch = db.prepare('SELECT * FROM product_batches WHERE id = ? AND product_id = ?').get(batchId, productId);
    if (!batch) throw notFound('الدفعة غير موجودة');
    return batch;
  };

  // تعديل الدفعة (جرد: تصحيح الكمية أو الرقم أو التاريخ)
  router.patch('/:id/batches/:batchId', canWrite, (req, res) => {
    const id = idParam.parse(req.params.id);
    const batch = findBatch(id, idParam.parse(req.params.batchId));
    const data = batchUpdateSchema.parse(req.body);
    db.prepare('UPDATE product_batches SET batch_no = ?, expiry_date = ?, quantity = ? WHERE id = ?').run(
      data.batchNo ?? batch.batch_no,
      data.expiryDate !== undefined ? data.expiryDate : batch.expiry_date,
      data.quantity ?? batch.quantity,
      batch.id
    );
    res.json(findProduct(id));
  });

  // حذف دفعة (مثلاً بعد إتلاف دفعة منتهية). الطلبات المجهزة منها تحتفظ برقمها وتاريخها.
  router.delete('/:id/batches/:batchId', canWrite, (req, res) => {
    const id = idParam.parse(req.params.id);
    const batch = findBatch(id, idParam.parse(req.params.batchId));
    db.prepare('DELETE FROM product_batches WHERE id = ?').run(batch.id);
    res.json(findProduct(id));
  });

  return router;
};
