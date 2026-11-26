'use strict';

/**
 * منطق المخزون: الدفعات، تواريخ الانتهاء، والصرف حسب الأقرب انتهاءً (FEFO).
 *
 * قواعد:
 *  - المخزون المتاح لدواء = مجموع كميات دفعاته غير المنتهية (expiry_date >= اليوم أو بلا تاريخ).
 *  - الدفعات المنتهية تبقى ظاهرة (للإتلاف أو الإرجاع للمورد) لكنها لا تُباع.
 *  - عند التجهيز يُصرف من الدفعة الأقرب انتهاءً أولاً، والدفعات بلا تاريخ في الأخير.
 *
 * كل الدوال متزامنة (better-sqlite3) وتُستدعى داخل معاملة من المسار.
 */

// ترتيب FEFO: الأقرب انتهاءً أولاً، الدفعات بلا تاريخ أخيراً، ثم الأقدم إدخالاً
const FEFO_ORDER = 'expiry_date IS NULL, expiry_date, id';

function mapBatch(b, today) {
  return {
    id: b.id,
    batchNo: b.batch_no,
    expiryDate: b.expiry_date,
    quantity: b.quantity,
    expired: b.expiry_date != null && b.expiry_date < today,
  };
}

/** كل الأدوية مع المخزون المتاح والمنتهي وأقرب تاريخ انتهاء وقائمة الدفعات. */
function listProducts(db, today, productId = null) {
  const where = productId == null ? '' : 'WHERE p.id = @productId';
  const rows = db.prepare(`
    SELECT p.id, p.name, p.type, p.price, p.image,
      COALESCE(SUM(CASE WHEN b.expiry_date IS NULL OR b.expiry_date >= @today THEN b.quantity END), 0) AS stock,
      COALESCE(SUM(CASE WHEN b.expiry_date < @today THEN b.quantity END), 0) AS expiredStock,
      MIN(CASE WHEN b.expiry_date >= @today THEN b.expiry_date END) AS nearestExpiry
    FROM products p
    LEFT JOIN product_batches b ON b.product_id = p.id AND b.quantity > 0
    ${where}
    GROUP BY p.id
    ORDER BY p.name COLLATE NOCASE`).all({ today, productId });
  if (rows.length === 0) return [];

  const batches = db.prepare(`
    SELECT * FROM product_batches
    WHERE quantity > 0 ${productId == null ? '' : 'AND product_id = @productId'}
    ORDER BY ${FEFO_ORDER}`).all({ productId });
  const byProduct = new Map(rows.map((r) => [r.id, []]));
  for (const b of batches) {
    const list = byProduct.get(b.product_id);
    if (list) list.push(mapBatch(b, today));
  }
  return rows.map((r) => ({ ...r, batches: byProduct.get(r.id) }));
}

function getProduct(db, id, today) {
  return listProducts(db, today, id)[0];
}

function availableStock(db, productId, today) {
  return db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS n FROM product_batches
    WHERE product_id = ? AND quantity > 0 AND (expiry_date IS NULL OR expiry_date >= ?)`).get(productId, today).n;
}

/**
 * يصرف كمية من دفعات الدواء حسب FEFO ويعيد ما صُرف من كل دفعة.
 * يرمي خطأ إن لم تكفِ الكمية المتاحة (والمعاملة المحيطة تُلغي كل شيء).
 */
function allocateFefo(db, productId, quantity, today) {
  const batches = db.prepare(`
    SELECT * FROM product_batches
    WHERE product_id = ? AND quantity > 0 AND (expiry_date IS NULL OR expiry_date >= ?)
    ORDER BY ${FEFO_ORDER}`).all(productId, today);
  const dec = db.prepare('UPDATE product_batches SET quantity = quantity - ? WHERE id = ?');
  const allocations = [];
  let remaining = quantity;
  for (const b of batches) {
    if (remaining === 0) break;
    const take = Math.min(b.quantity, remaining);
    dec.run(take, b.id);
    allocations.push({ batchId: b.id, batchNo: b.batch_no, expiryDate: b.expiry_date, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) {
    const err = new Error('INSUFFICIENT_STOCK');
    err.available = quantity - remaining;
    throw err;
  }
  return allocations;
}

/**
 * يعيد كمية إلى المخزون: إلى نفس الدفعة إن وُجدت، وإلا إلى دفعة بنفس الرقم والتاريخ،
 * وإلا تُنشأ دفعة جديدة بهذا الرقم والتاريخ.
 */
function restock(db, productId, { batchId = null, batchNo = '', expiryDate = null }, quantity) {
  if (batchId != null) {
    const r = db.prepare('UPDATE product_batches SET quantity = quantity + ? WHERE id = ? AND product_id = ?')
      .run(quantity, batchId, productId);
    if (r.changes > 0) return;
  }
  const same = db.prepare(`
    SELECT id FROM product_batches
    WHERE product_id = ? AND batch_no = ? AND expiry_date IS ?
    ORDER BY id LIMIT 1`).get(productId, batchNo, expiryDate);
  if (same) {
    db.prepare('UPDATE product_batches SET quantity = quantity + ? WHERE id = ?').run(quantity, same.id);
  } else {
    db.prepare('INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity) VALUES (?, ?, ?, ?)')
      .run(productId, batchNo, expiryDate, quantity);
  }
}

module.exports = { listProducts, getProduct, availableStock, allocateFefo, restock, mapBatch };
