'use strict';

/**
 * الصلاحيات تُفرض هنا على الخادم. الواجهة تستخدم نفس القائمة فقط لإخفاء الأزرار غير المسموحة.
 */
const PERMISSIONS = {
  PRODUCTS_WRITE: 'products:write',   // إضافة وتعديل الأدوية
  PRODUCTS_DELETE: 'products:delete',
  ORDERS_CREATE: 'orders:create',     // إنشاء فاتورة من السلة
  ORDERS_MANAGE: 'orders:manage',     // تجهيز / استرجاع / حذف الطلبات
  REPORTS: 'reports',
  BACKUP: 'backup',                   // نسخ احتياطي واستعادة
  USERS: 'users',                     // إدارة المستخدمين
};

const P = PERMISSIONS;

const ROLE_PERMISSIONS = {
  admin: Object.values(P),
  manager: [P.PRODUCTS_WRITE, P.ORDERS_CREATE, P.ORDERS_MANAGE, P.REPORTS],
  cashier: [P.ORDERS_CREATE],
};

const ROLE_LABELS = {
  admin: 'مدير النظام',
  manager: 'مشرف',
  cashier: 'مندوب / كاشير',
};

function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function hasPermission(user, permission) {
  return Boolean(user) && permissionsFor(user.role).includes(permission);
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, ROLE_LABELS, permissionsFor, hasPermission };
