'use strict';

/** تاريخ اليوم YYYY-MM-DD في منطقة زمنية محددة (افتراضياً بغداد) بغض النظر عن توقيت الخادم. */
function localDate(timeZone, date = new Date()) {
  // en-CA يعطي الصيغة YYYY-MM-DD مباشرة
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// أرقام عربية (٠-٩) وفارسية (۰-۹) إلى أرقام لاتينية
const toLatinDigits = (s) => s
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/**
 * يحوّل تواريخ البيانات القديمة إلى YYYY-MM-DD.
 * يقبل: 2025-10-18 ، 2025-10-18T..، ١٨‏/١٠‏/٢٠٢٥ (يوم/شهر/سنة بأرقام عربية كما في نسخة الخادم القديمة).
 * يعيد null إن لم يتعرف على الصيغة.
 */
function normalizeDate(value) {
  if (value == null) return null;
  const s = toLatinDigits(String(value)).replace(/[‎‏؜\s]/g, '');
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return isValidYMD(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const [d, mo, y] = [+m[1], +m[2], +m[3]];
    return isValidYMD(y, mo, d) ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  }
  return null;
}

function isValidYMD(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

module.exports = { localDate, normalizeDate };
