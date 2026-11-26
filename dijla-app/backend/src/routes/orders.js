'use strict';

const express = require('express');
const { notFound, conflict, badRequest } = require('../errors');
const { orderSchema, idParam } = require('../validation');
const { PERMISSIONS: P } = require('../permissions');
const { localDate } = require('../dates');
const { availableStock, allocateFefo, restock } = require('../inventory');

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
  // الدفعات التي صُرف منها كل صنف (للطلبات المجهزة)
  const allocations = items.length === 0 ? [] : db.prepare(`
    SELECT order_item_id, batch_no, expiry_date, quantity FROM order_item_batches
    WHERE order_item_id IN (${items.map(() => '?').join(',')})
    ORDER BY id`).all(...items.map((it) => it.id));
  const byItem = new Map();
  for (const a of allocations) {
    if (!byItem.has(a.order_item_id)) byItem.set(a.order_item_id, []);
    byItem.get(a.order_item_id).push({ batchNo: a.batch_no, expiryDate: a.expiry_date, quantity: a.quantity });
  }
  const byOrder = new Map(orders.map((o) => [o.id, []]));
  for (const it of items) {
    byOrder.get(it.order_id).push({
      id: it.product_id, name: it.name, type: it.type, price: it.price, quantity: it.quantity,
      batches: byItem.get(it.id) || [],
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
  const getProduct = db.prepare('SELECT id, name, type, price FROM products WHERE id = ?');
  const today = () => localDate(config.timeZone);

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
        const stock = availableStock(db, productId, today()); // بدون الدفعات المنتهية
        if (stock < quantity) {
          throw conflict(`الكمية المتاحة (غير المنتهية) من ${product.name}: ${stock} فقط`);
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

  /**
   * تم التجهيز: يصرف من الدفعات حسب الأقرب انتهاءً (FEFO) ويسجّل من أي دفعة خرج كل صنف،
   * ويغيّر الحالة، في معاملة واحدة (إما ينجح كله أو لا شيء).
   */
  router.post('/:id/complete', auth.requirePermission(P.ORDERS_MANAGE), (req, res) => {
    const id = idParam.parse(req.params.id);
    db.transaction(() => {
      const row = getStatus.get(id);
      if (!row) throw notFound('الطلب غير موجود');
      if (row.status !== 'pending') throw conflict('يمكن تجهيز الطلبات المعلقة فقط');
      const items = db.prepare('SELECT id, product_id, name, quantity FROM order_items WHERE order_id = ?').all(id);
      const record = db.prepare(`INSERT INTO order_item_batches (order_item_id, batch_id, batch_no, expiry_date, quantity)
                                 VALUES (?, ?, ?, ?, ?)`);
      for (const it of items) {
        if (it.product_id == null || !getProduct.get(it.product_id)) {
          throw conflict(`الصنف ${it.name} لم يعد موجوداً في المخزون`);
        }
        let allocations;
        try {
          allocations = allocateFefo(db, it.product_id, it.quantity, today());
        } catch (err) {
          if (err.message !== 'INSUFFICIENT_STOCK') throw err;
          throw conflict(`الكمية غير المنتهية غير كافية من ${it.name} (المتاح: ${err.available})`);
        }
        for (const a of allocations) record.run(it.id, a.batchId, a.batchNo, a.expiryDate, a.quantity);
      }
      db.prepare(`UPDATE orders SET status = 'completed', completed_date = ? WHERE id = ?`).run(today(), id);
    })();
    res.json(getOrder(id));
  });

  /** استرجاع طلب مكتمل: يعيد الكميات إلى نفس الدفعات التي صُرفت منها. */
  router.post('/:id/return', auth.requirePermission(P.ORDERS_MANAGE), (req, res) => {
    const id = idParam.parse(req.params.id);
    db.transaction(() => {
      const row = getStatus.get(id);
      if (!row) throw notFound('الطلب غير موجود');
      if (row.status !== 'completed') throw conflict('يمكن استرجاع الطلبات المكتملة فقط');
      const items = db.prepare('SELECT id, product_id, quantity FROM order_items WHERE order_id = ?').all(id);
      const allocationsOf = db.prepare('SELECT * FROM order_item_batches WHERE order_item_id = ?');
      for (const it of items) {
        // الأصناف المحذوفة من قائمة الأدوية لا يمكن إعادتها (product_id = NULL) فتُتجاهل
        if (it.product_id == null || !getProduct.get(it.product_id)) continue;
        const allocations = allocationsOf.all(it.id);
        if (allocations.length === 0) {
          // طلبات جُهزت قبل نظام الدفعات: تعود إلى دفعة "غير محددة"
          restock(db, it.product_id, {}, it.quantity);
        }
        for (const a of allocations) {
          restock(db, it.product_id, { batchId: a.batch_id, batchNo: a.batch_no, expiryDate: a.expiry_date }, a.quantity);
        }
      }
      db.prepare(`UPDATE orders SET status = 'returned', returned_date = ? WHERE id = ?`).run(today(), id);
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
