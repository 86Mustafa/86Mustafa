'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const notFound = (msg = 'غير موجود') => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

/**
 * معالج الأخطاء العام: لا يُرسل تفاصيل داخلية (stack) للعميل أبداً.
 */
function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({
        error: 'بيانات غير صالحة',
        details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    if (err && err.name === 'MulterError') {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'حجم الصورة أكبر من المسموح (3 ميغابايت)' : 'خطأ في رفع الملف';
      return res.status(400).json({ error: msg });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'حجم البيانات المرسلة كبير جداً' });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'صيغة JSON غير صالحة' });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    logger.error('UNHANDLED ERROR:', err);
    return res.status(500).json({ error: 'حدث خطأ في الخادم' });
  };
}

module.exports = { HttpError, badRequest, notFound, conflict, errorHandler };
