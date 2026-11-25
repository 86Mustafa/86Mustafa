'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { badRequest } = require('./errors');

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const URL_PREFIX = '/uploads/';

// نتحقق من البصمة الفعلية للملف (magic bytes) ولا نثق بالامتداد أو نوع MIME المرسل
function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6))) return 'gif';
  return null;
}

function createImageStore(uploadsDir) {
  fs.mkdirSync(uploadsDir, { recursive: true });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10 },
  });

  /** يحفظ صورة (Buffer) بعد التحقق من نوعها ويعيد رابطها النسبي. */
  function saveBuffer(buf) {
    const ext = detectImageType(buf);
    if (!ext) throw badRequest('الملف المرفوع ليس صورة مدعومة (JPG, PNG, WEBP, GIF)');
    if (buf.length > MAX_IMAGE_BYTES) throw badRequest('حجم الصورة أكبر من المسموح (3 ميغابايت)');
    const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, name), buf);
    return URL_PREFIX + name;
  }

  /** يحوّل صور data:image/...;base64 (من النسخ الاحتياطية القديمة) إلى ملفات. يعيد '' إن لم تكن صالحة. */
  function saveDataUrl(dataUrl) {
    const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
    if (!m) return '';
    try {
      return saveBuffer(Buffer.from(m[1], 'base64'));
    } catch {
      return '';
    }
  }

  /** يحذف صورة مرفوعة سابقاً (يتجاهل الروابط الخارجية وأي مسار خارج مجلد الرفع). */
  function remove(imageUrl) {
    if (typeof imageUrl !== 'string' || !imageUrl.startsWith(URL_PREFIX)) return;
    const name = path.basename(imageUrl);
    if (!/^[a-f0-9]{32}\.(jpg|png|webp|gif)$/.test(name)) return;
    fs.rm(path.join(uploadsDir, name), { force: true }, () => {});
  }

  return { single: (field) => upload.single(field), saveBuffer, saveDataUrl, remove };
}

module.exports = { createImageStore, detectImageType };
