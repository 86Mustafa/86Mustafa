'use strict';

const { z } = require('zod');

const text = (max, label) =>
  z.string({ error: `${label} مطلوب` }).trim().max(max, `${label} يجب ألا يتجاوز ${max} حرفاً`);

// الحقول تصل كنصوص عند الإرسال بصيغة multipart (مع الصورة)، لذا نحوّلها لأرقام
const productSchema = z.object({
  name: text(120, 'اسم الدواء').min(2, 'اسم الدواء يجب أن يكون على الأقل حرفين'),
  type: text(50, 'النوع').min(1, 'النوع مطلوب'),
  price: z.coerce.number({ error: 'السعر غير صالح' }).positive('السعر يجب أن يكون أكبر من صفر').max(1e9, 'السعر كبير جداً'),
  stock: z.coerce.number({ error: 'الكمية غير صالحة' }).int('الكمية يجب أن تكون عدداً صحيحاً')
    .min(0, 'الكمية لا يمكن أن تكون سالبة').max(10_000_000, 'الكمية كبيرة جداً'),
});

const orderSchema = z.object({
  pharmacy: text(120, 'اسم الصيدلية').min(1, 'يرجى إدخال اسم الصيدلية'),
  notes: text(1000, 'الملاحظات').optional().default(''),
  items: z.array(z.object({
    productId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int('الكمية يجب أن تكون عدداً صحيحاً').min(1, 'الكمية يجب أن تكون 1 على الأقل').max(100_000),
  }), { error: 'قائمة الأصناف مطلوبة' }).min(1, 'السلة فارغة').max(500, 'عدد الأصناف كبير جداً'),
});

const passwordSchema = z.string().min(8, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل').max(128, 'كلمة المرور طويلة جداً');
const roleSchema = z.enum(['admin', 'manager', 'cashier'], { error: 'الدور غير صالح' });

const loginSchema = z.object({
  username: z.string().trim().min(1, 'اسم المستخدم مطلوب').max(64),
  password: z.string().min(1, 'كلمة المرور مطلوبة').max(128),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'كلمة المرور الحالية مطلوبة').max(128),
  newPassword: passwordSchema,
});

const createUserSchema = z.object({
  username: z.string().trim().regex(/^[A-Za-z0-9_.-]{3,32}$/, 'اسم المستخدم: 3-32 حرفاً إنجليزياً أو أرقاماً أو . _ -'),
  displayName: text(60, 'الاسم').min(1, 'الاسم مطلوب'),
  role: roleSchema,
  password: passwordSchema,
});

const updateUserSchema = z.object({
  displayName: text(60, 'الاسم').min(1, 'الاسم مطلوب').optional(),
  role: roleSchema.optional(),
  active: z.boolean().optional(),
  password: passwordSchema.optional(), // إعادة تعيين كلمة المرور من قبل المدير
});

const idParam = z.coerce.number().int().positive();

module.exports = {
  productSchema, orderSchema, loginSchema, changePasswordSchema,
  createUserSchema, updateUserSchema, idParam,
};
