'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { buildConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { ensureInitialAdmin } = require('../src/auth');
const { createApp } = require('../src/app');

// صورة PNG صغيرة (1x1)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const silent = { log() {}, error() {} };

let tmp, db, app, config;

async function login(username, password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return agent;
}

async function createUser(adminAgent, username, role) {
  const res = await adminAgent.post('/api/users').send({ username, displayName: username, role, password: 'temp-pass-1' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const agent = await login(username, 'temp-pass-1');
  const ch = await agent.post('/api/auth/change-password').send({ currentPassword: 'temp-pass-1', newPassword: 'final-pass-1' });
  assert.equal(ch.status, 200);
  return agent;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dijla-test-'));
  config = buildConfig({ dataDir: tmp, dbPath: ':memory:', uploadsDir: path.join(tmp, 'uploads'), jwtSecret: 'test-secret', adminPassword: '' });
  db = openDatabase(config.dbPath);
  app = createApp({ db, config, logger: silent });
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('المصادقة', () => {
  let adminPassword;
  let admin;

  test('أول تشغيل ينشئ مديراً بكلمة مرور مؤقتة', () => {
    const created = ensureInitialAdmin(db, config, silent);
    assert.ok(created.generated);
    assert.ok(created.password.length >= 12);
    adminPassword = created.password;
    assert.equal(ensureInitialAdmin(db, config, silent), null, 'لا يُنشأ مدير ثانٍ');
  });

  test('الوصول بدون دخول مرفوض', async () => {
    assert.equal((await request(app).get('/api/products')).status, 401);
    assert.equal((await request(app).get('/api/auth/me')).status, 401);
  });

  test('كلمة مرور خاطئة مرفوضة برسالة عامة', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
    assert.equal(res.status, 401);
    const res2 = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'wrong' });
    assert.equal(res2.body.error, res.body.error, 'نفس الرسالة لا تكشف وجود المستخدم');
  });

  test('ملف الجلسة httpOnly و SameSite=Strict', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: adminPassword });
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test('كلمة المرور المؤقتة يجب تغييرها قبل أي عملية', async () => {
    admin = await login('admin', adminPassword);
    const me = await admin.get('/api/auth/me');
    assert.equal(me.body.user.mustChangePassword, true);
    assert.equal((await admin.get('/api/products')).status, 403);
    const bad = await admin.post('/api/auth/change-password').send({ currentPassword: adminPassword, newPassword: 'short' });
    assert.equal(bad.status, 400);
    const ok = await admin.post('/api/auth/change-password').send({ currentPassword: adminPassword, newPassword: 'admin-pass-123' });
    assert.equal(ok.status, 200);
    assert.equal((await admin.get('/api/products')).status, 200);
  });

  test('تغيير كلمة المرور يُنهي الجلسات الأخرى', async () => {
    const other = await login('admin', 'admin-pass-123');
    const ch = await admin.post('/api/auth/change-password').send({ currentPassword: 'admin-pass-123', newPassword: 'admin-pass-456' });
    assert.equal(ch.status, 200);
    assert.equal((await other.get('/api/products')).status, 401);
    assert.equal((await admin.get('/api/products')).status, 200, 'الجلسة الحالية تبقى');
  });

  test('تسجيل الخروج', async () => {
    const a = await login('admin', 'admin-pass-456');
    await a.post('/api/auth/logout');
    assert.equal((await a.get('/api/auth/me')).status, 401);
  });
});

describe('الأدوية والطلبات', () => {
  let admin, manager, cashier, productId;

  before(async () => {
    admin = await login('admin', 'admin-pass-456');
    manager = await createUser(admin, 'manager1', 'manager');
    cashier = await createUser(admin, 'cashier1', 'cashier');
  });

  test('إضافة دواء مع صورة، والتحقق من البيانات', async () => {
    const bad = await admin.post('/api/products').field('name', 'x').field('type', '').field('price', '-1').field('stock', '1.5');
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.length >= 3);

    const res = await admin.post('/api/products')
      .field('name', 'باراسيتامول').field('type', 'حبوب').field('price', '2500').field('stock', '10')
      .attach('image', PNG, { filename: 'p.png', contentType: 'image/png' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.image, /^\/uploads\/[a-f0-9]{32}\.png$/);
    productId = res.body.id;

    assert.equal((await admin.get(res.body.image)).status, 200);
    assert.equal((await request(app).get(res.body.image)).status, 401, 'الصور للمسجلين فقط');
  });

  test('رفض ملف ليس صورة حتى لو ادّعى أنه صورة', async () => {
    const res = await admin.post('/api/products')
      .field('name', 'دواء').field('type', 'حبوب').field('price', '1').field('stock', '1')
      .attach('image', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' });
    assert.equal(res.status, 400);
  });

  test('الصلاحيات: الكاشير لا يضيف أدوية، والمشرف لا يحذف', async () => {
    assert.equal((await cashier.post('/api/products').field('name', 'aa').field('type', 'b').field('price', '1').field('stock', '1')).status, 403);
    assert.equal((await manager.delete(`/api/products/${productId}`)).status, 403);
    assert.equal((await manager.get('/api/users')).status, 403);
    assert.equal((await manager.get('/api/backup')).status, 403);
  });

  test('الخادم يحسب السعر بنفسه ويتحقق من المخزون', async () => {
    const tooMany = await cashier.post('/api/orders').send({ pharmacy: 'صيدلية', items: [{ productId, quantity: 11 }] });
    assert.equal(tooMany.status, 409);

    const res = await cashier.post('/api/orders').send({
      pharmacy: 'صيدلية النور', notes: 'سريع',
      items: [{ productId, quantity: 2, price: 1 }, { productId, quantity: 1 }], // السعر المرسل يُتجاهل، والمكرر يُدمج
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.total, 7500);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].quantity, 3);
    assert.match(res.body.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(res.body.createdBy, 'cashier1');
    const stock = (await admin.get(`/api/products/${productId}`)).body.stock;
    assert.equal(stock, 10, 'المخزون لا يُخصم عند الإنشاء');
  });

  test('دورة الطلب: تجهيز ثم استرجاع ثم حذف', async () => {
    const order = (await manager.post('/api/orders').send({ pharmacy: 'ص', items: [{ productId, quantity: 4 }] })).body;

    assert.equal((await cashier.post(`/api/orders/${order.id}/complete`)).status, 403);
    assert.equal((await manager.post(`/api/orders/${order.id}/return`)).status, 409, 'لا يُسترجع طلب معلق');

    const done = await manager.post(`/api/orders/${order.id}/complete`);
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'completed');
    assert.equal((await admin.get(`/api/products/${productId}`)).body.stock, 6);
    assert.equal((await manager.post(`/api/orders/${order.id}/complete`)).status, 409, 'لا يُجهَّز مرتين');
    assert.equal((await manager.delete(`/api/orders/${order.id}`)).status, 409, 'لا يُحذف طلب مكتمل');

    const ret = await manager.post(`/api/orders/${order.id}/return`);
    assert.equal(ret.body.status, 'returned');
    assert.ok(ret.body.returnedDate);
    assert.equal((await admin.get(`/api/products/${productId}`)).body.stock, 10);

    assert.equal((await manager.delete(`/api/orders/${order.id}`)).status, 200);
    assert.equal((await manager.get(`/api/orders/${order.id}`)).status, 404);
  });

  test('التجهيز يفشل كاملاً إذا نقص صنف واحد (معاملة)', async () => {
    const p2 = (await admin.post('/api/products').field('name', 'أموكسيسيلين').field('type', 'حبوب').field('price', '5000').field('stock', '5')).body;
    const order = (await admin.post('/api/orders').send({ pharmacy: 'ص', items: [{ productId, quantity: 2 }, { productId: p2.id, quantity: 5 }] })).body;
    await admin.put(`/api/products/${p2.id}`).field('name', p2.name).field('type', p2.type).field('price', '5000').field('stock', '1');
    assert.equal((await admin.post(`/api/orders/${order.id}/complete`)).status, 409);
    assert.equal((await admin.get(`/api/products/${productId}`)).body.stock, 10, 'لم يُخصم الصنف الأول');
  });

  test('حذف دواء لا يفسد الطلبات القديمة', async () => {
    const p = (await admin.post('/api/products').field('name', 'مؤقت').field('type', 'حبوب').field('price', '100').field('stock', '5')).body;
    const order = (await admin.post('/api/orders').send({ pharmacy: 'ص', items: [{ productId: p.id, quantity: 1 }] })).body;
    assert.equal((await admin.delete(`/api/products/${p.id}`)).status, 200);
    const after = (await admin.get(`/api/orders/${order.id}`)).body;
    assert.equal(after.items[0].name, 'مؤقت');
    assert.equal(after.items[0].id, null);
    assert.equal((await admin.post(`/api/orders/${order.id}/complete`)).status, 409);
  });
});

describe('المستخدمون', () => {
  let admin;
  before(async () => { admin = await login('admin', 'admin-pass-456'); });

  test('لا يمكن تعطيل آخر مدير أو تعطيل النفس', async () => {
    const me = (await admin.get('/api/auth/me')).body.user;
    assert.equal((await admin.patch(`/api/users/${me.id}`).send({ active: false })).status, 409);
    assert.equal((await admin.patch(`/api/users/${me.id}`).send({ role: 'cashier' })).status, 409);
  });

  test('تعطيل مستخدم يُنهي جلسته فوراً', async () => {
    const agent = await createUser(admin, 'temp1', 'cashier');
    const users = (await admin.get('/api/users')).body;
    const u = users.find((x) => x.username === 'temp1');
    assert.ok(!('password_hash' in u) && !('passwordHash' in u), 'لا تُرسل كلمات المرور');
    assert.equal((await admin.patch(`/api/users/${u.id}`).send({ active: false })).status, 200);
    assert.equal((await agent.get('/api/products')).status, 401);
    const relogin = await request(app).post('/api/auth/login').send({ username: 'temp1', password: 'final-pass-1' });
    assert.equal(relogin.status, 401);
  });

  test('اسم مستخدم مكرر مرفوض', async () => {
    const res = await admin.post('/api/users').send({ username: 'ADMIN', displayName: 'x', role: 'cashier', password: '12345678' });
    assert.equal(res.status, 409);
  });
});

describe('النسخ الاحتياطي والاستعادة', () => {
  let admin;
  before(async () => { admin = await login('admin', 'admin-pass-456'); });

  test('استعادة نسخة من الواجهة القديمة (localStorage) بحالات عربية وصور مضمّنة', async () => {
    const legacy = {
      products: [
        { id: 1, name: 'باراسيتامول', type: 'حبوب', price: 2500, stock: 50, image: 'https://via.placeholder.com/400x300?text=x' },
        { id: 2, name: 'مرهم', type: 'مرهم', price: '7500', stock: 15, image: `data:image/png;base64,${PNG.toString('base64')}` },
        { id: 3, name: '<img src=x onerror=alert(1)>', type: 'حبوب', price: 1, stock: -4, image: 'javascript:alert(1)' },
      ],
      orders: [
        { id: 1, pharmacy: 'صيدلية الحياة', notes: 'تجهيز سريع', date: '2025-11-02', status: 'مكتمل',
          items: [{ id: 1, name: 'باراسيتامول', type: 'حبوب', price: 2500, quantity: 2 }] },
        { id: 2, pharmacy: 'المنزل', date: '١٨‏/١٠‏/٢٠٢٥', status: 'معلقة',
          items: [{ id: 2, name: 'مرهم', type: 'مرهم', price: 7500, quantity: 1 }, { id: 99, name: 'محذوف', price: 1, quantity: 1 }] },
        { id: 3, pharmacy: 'x', status: 'مسترجعة', date: 'garbage', items: [] },
      ],
      timestamp: '2025-11-02T10:00:00Z',
    };
    const res = await admin.post('/api/restore').send(legacy);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.products, res.body.orders], [3, 2]);

    const products = (await admin.get('/api/products')).body;
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));
    assert.equal(byId[1].image, '', 'روابط placeholder تُزال');
    assert.match(byId[2].image, /^\/uploads\/.+\.png$/, 'الصورة المضمنة تتحول لملف');
    assert.equal(byId[2].price, 7500);
    assert.equal(byId[3].stock, 0);
    assert.equal(byId[3].image, '');

    const orders = (await admin.get('/api/orders')).body;
    assert.equal(orders[0].status, 'completed');
    assert.equal(orders[0].total, 5000);
    assert.equal(orders[1].status, 'pending');
    assert.equal(orders[1].date, '2025-10-18', 'التاريخ بالأرقام العربية يُحوَّل');
    assert.equal(orders[1].items[1].id, null, 'صنف غير موجود يبقى في الطلب بدون ربط');
  });

  test('النسخة الاحتياطية تتضمن الصور وتُستعاد كما هي', async () => {
    const backup = (await admin.get('/api/backup')).body;
    assert.equal(backup.format, 'dijla-backup');
    assert.match(backup.products.find((p) => p.id === 2).image, /^data:image\/png;base64,/);
    const res = await admin.post('/api/restore').send(backup);
    assert.equal(res.status, 200);
    const again = (await admin.get('/api/orders')).body;
    assert.equal(again.length, 2);
    assert.equal(again[0].status, 'completed');
  });

  test('ملف غير صالح مرفوض', async () => {
    assert.equal((await admin.post('/api/restore').send({ foo: 1 })).status, 400);
  });
});

describe('الأمان العام', () => {
  test('لا يمكن الوصول لملفات الخادم أو قاعدة البيانات عبر الويب', async () => {
    for (const p of ['/backend/src/app.js', '/../backend/package.json', '/.env', '/data/dijla.db', '/backend/data/.jwt-secret']) {
      const res = await request(app).get(p);
      assert.notEqual(res.status, 200, p);
    }
  });

  test('الواجهة تُقدَّم مع ترويسات الأمان', async () => {
    const res = await request(app).get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  test('الأخطاء لا تكشف تفاصيل داخلية', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad');
    assert.equal(res.status, 400);
    assert.ok(!JSON.stringify(res.body).includes('at '), 'لا يوجد stack');
  });
});
