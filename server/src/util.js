'use strict';
const crypto = require('crypto');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function id(prefix) {
  let s = '';
  const bytes = crypto.randomBytes(10);
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Cyrillic-aware slug: transliterates BG → latin, keeps URLs and file paths sane. */
const CYR = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',
  щ:'sht',ъ:'a',ь:'y',ю:'yu',я:'ya',
};
function slugify(input) {
  const lower = String(input || '').toLowerCase().trim();
  let out = '';
  for (const ch of lower) out += CYR[ch] !== undefined ? CYR[ch] : ch;
  return (
    out
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const httpError = (status, code, message) => new HttpError(status, code, message);

/** Wrap an async route so rejections reach the error middleware. */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Cheap page count straight off the PDF bytes — no parser dependency. */
function pdfPageCount(buffer) {
  try {
    const s = buffer.toString('latin1');
    const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map((m) => parseInt(m[1], 10));
    if (counts.length) return Math.max(...counts);
    const pages = s.match(/\/Type\s*\/Page[^s]/g);
    return pages ? pages.length : null;
  } catch {
    return null;
  }
}

const isPdf = (buffer) => buffer && buffer.length > 4 && buffer.subarray(0, 4).toString() === '%PDF';

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  null;

module.exports = { id, sha256, slugify, HttpError, httpError, asyncH, pdfPageCount, isPdf, clientIp };
