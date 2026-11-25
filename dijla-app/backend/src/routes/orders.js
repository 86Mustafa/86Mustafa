'use strict';

const express = require('express');
const { notFound, conflict, badRequest } = require('../errors');
const { orderSchema, idParam } = require('../validation');
const { PERMISSIONS: P } = require('../permissions');
const { localDate } = require('../dates');

/** يحوّل صفوف قاعدة البيانات إلى الشكل الذي تستخدمه الواجهة. */
function loadOrders(db, whereSql = '', params = []) {
  const orders = db.prepare(`
    SELECT o.*, u.display_name AS created_by_name
    FROM orders o LEFT JOIN users u ON u.id = o.created_by
    ${whereSql}
    ORDER BY o.id`).all(...params);
  if (orders.length === 0) return [];
  const items = db.prepare(`
    SELECT * FROM order_items
    WHERE order_id IN (${orders.map(() => '?').join(',')})
    ORDER BY id`).all(...orders.map((o) => o.id));
  const byOrder = new Map(orders.map((o) => [o.id, []]));
  for (const it of items) {
    byOrder.get(it.order_id).push({
      id: it.product_id, name: it.name, type: it.type, price: it.price, quantity: it.quantity,
    });
  }
  return orders.map((o) => ({
    id: o.id,
    pharmacy: o.pharmacy,
    notes: o.notes,
    status: o.status,
    date: o.order_date,
    completedDate: o.completed_date,
    returnedDate: o.returned_date,
    total: o.total,
    createdBy: o.created_by_name || null,
    items: byOrder.get(o.id),
  }));
}

module.exports = function orderRoutes({ db, auth, config }) {
  const router = express.Router();

  const getOrder = (id) => loadOrders(db, 'WHERE o.id = ?', [id])[0];
  const getStatus = db.prepare('SELECT status FROM orders WHERE id = ?');
  const getProduct = db.prepare('SELECT id, name, type, price, stock FROM products WHERE id = ?');

  router.get('/', (req, res) => {
    res.json(loadOrders(db));
  });

  router.get('/:id', (req, res) => {
    const order = getOrder(idParam.parse(req.params.id));
    if (!order) throw notFound('الطلب غير موجود');
    res.json(order);
  });

  /**
   * إنشاء طلب: العميل يرسل معرّف الصنف والكمية فقط، والخادم يأخذ الاسم والسعر من قاعدة البيانات
   * ويحسب الإجمالي بنفسه، فلا يمكن التلاعب بالأسعار من المتصفح.
   * المخزون لا يُخصم هنا بل عند "تم التجهيز".
   */
  router.post('/', auth.requirePermission(P.ORDERS_CREATE), (req, res) => {
    const data = orderSchema.parse(req.body);

    // دمج الأصناف المكررة
    const quantities = new Map();
    for (const it of data.items) quantities.set(it.productId, (quantities.get(it.productId) || 0) + it.quantity);

    const create = db.transaction(() => {
      const lines = [];
      for (const [productId, quantity] of quantities) {
        const product = getProduct.get(productId);
        if (!product) throw badRequest(`الصنف رقم ${productId} غير موجود (ربما حُذف)، حدّث السلة`);
        if (product.stock < quantity) {
          throw conflict(`الكمية المتاحة من ${product.name}: ${product.stock} فقط`);
        }
        lines.push({ product, quantity });
      }
      const total = lines.reduce((sum, l) => sum + l.product.price * l.quantity, 0);
      const { lastInsertRowid: orderId } = db.prepare(`
        INSERT INTO orders (pharmacy, notes, status, order_date, total, created_by)
        VALUES (?, ?, 'pending', ?, ?, ?)`)
        .run(data.pharmacy, data.notes, localDate(config.timeZone), total, req.user.id);
      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, name, type, price, quantity) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const { product, quantity } of lines) {
        insertItem.run(orderId, product.id, product.name, product.type, product.price, quantity);
      }
      return orderId;
    });

    res.status(201).json(getOrder(create()));
  });

  /** تم التجهيز: يخصم المخزون ويغيّر الحالة في معاملة واحدة (إما ينجح كله أو لا شيء). */
  router.post('/:id/complete', auth.requirePermission(P.ORDERS_MANAGE), (req, res) => {
    const id = idParam.parse(req.params.id);
    db.transaction(() => {
      const row = getStatus.get(id);
      if (!row) throw notFound('الطلب غير موجود');
      if (row.status !== 'pending') throw conflict('يمكن تجهيز الطلبات المعلقة فقط');
      const items = db.prepare('SELECT product_id, name, quantity FROM order_items WHERE order_id = ?').all(id);
      for (const it of items) {
        const product = it.product_id == null ? null : getProduct.get(it.product_id);
        if (!product) throw conflict(`الصنف ${it.name} لم يعد موجوداً في المخزون`);
        if (product.stock < it.quantity) throw conflict(`الكمية غير كافية من ${it.name} (المتاح: ${product.stock})`);
      }
      const dec = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
      for (const it of items) dec.run(it.quantity, it.product_id);
      db.prepare(`UPDATE orders SET status = 'completed', completed_date = ? WHERE id = ?`)
        .run(localDate(config.timeZone), id);
    })();
    res.json(getOrder(id));
  });

  /** استرجاع طلب مكتمل: يعيد الكميات إلى المخزون. */
  router.post('/:id/return', auth.requirePermission(P.ORDERS_MANAGE), (req, res) => {
    const id = idParam.parse(req.params.id);
    db.transaction(() => {
      const row = getStatus.get(id);
      if (!row) throw notFound('الطلب غير موجود');
      if (row.status !== 'completed') throw conflict('يمكن استرجاع الطلبات المكتملة فقط');
      // الأصناف المحذوفة من قائمة الأدوية لا يمكن إعادتها (product_id = NULL) فتُتجاهل
      db.prepare(`UPDATE products SET stock = stock + oi.quantity
                  FROM order_items oi WHERE oi.order_id = ? AND oi.product_id = products.id`).run(id);
      db.prepare(`UPDATE orders SET status = 'returned', returned_date = ? WHERE id = ?`)
        .run(localDate(config.timeZone), id);
    })();
    res.json(getOrder(id));
  });

  /** الحذف مسموح للطلبات المعلقة والمسترجعة فقط، حتى لا يختل حساب المخزون. */
  router.delete('/:id', auth.requirePermission(P.ORDERS_MANAGE), (req, res) => {
    const id = idParam.parse(req.params.id);
    const row = getStatus.get(id);
    if (!row) throw notFound('الطلب غير موجود');
    if (row.status === 'completed') throw conflict('لا يمكن حذف طلب مكتمل؛ استرجعه أولاً');
    db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return router;
};

module.exports.loadOrders = loadOrders;
