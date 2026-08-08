'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { q } = require('./db');
const { httpError, id } = require('./util');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const TOKEN_TTL = '12h';
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role, name: user.name }, SECRET, { expiresIn: TOKEN_TTL });

/** Populates req.user from a Bearer JWT. Does not reject — requireRole does that. */
async function loadUser(req, _res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  try {
    const payload = jwt.verify(header.slice(7), SECRET);
    const { rows } = await q(
      'SELECT id, email, name, role, active FROM users WHERE id = $1',
      [payload.sub]
    );
    if (rows[0] && rows[0].active) req.user = rows[0];
  } catch {
    /* expired or forged — treated as anonymous */
  }
  next();
}

const requireRole = (minRole) => (req, _res, next) => {
  if (!req.user) return next(httpError(401, 'UNAUTHENTICATED', 'Необходимо е вписване.'));
  if (ROLE_RANK[req.user.role] < ROLE_RANK[minRole])
    return next(httpError(403, 'FORBIDDEN', 'Нямате права за това действие.'));
  next();
};

// ---- Device keys -----------------------------------------------------------
// Format: sk_<prefix8>_<secret32>. Only the bcrypt hash of the full key is stored.

function generateDeviceKey() {
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  return { key: `sk_${prefix}_${secret}`, prefix };
}

// The secret is base64url, whose alphabet includes '_' — so the key cannot be parsed by
// splitting on '_'. Doing that rejected every key whose secret happened to contain one,
// which is about 40% of them. Match the prefix positionally instead and treat the whole
// remainder as the secret. The stored hash covers the entire key, so keys already issued
// keep working.
const DEVICE_KEY_RE = /^sk_([0-9a-f]{8})_(.+)$/;

async function requireDevice(req, _res, next) {
  const raw = req.headers['x-device-key'];
  if (!raw) return next(httpError(401, 'NO_DEVICE_KEY', 'Липсва ключ на устройството.'));
  // Typed on a touch keyboard or pasted from the admin panel: tolerate stray whitespace
  // rather than answering "invalid key" for an invisible trailing newline.
  const key = String(raw).trim();
  const match = DEVICE_KEY_RE.exec(key);
  if (!match)
    return next(httpError(401, 'BAD_DEVICE_KEY', 'Невалиден ключ на устройството.'));
  const { rows } = await q(
    'SELECT * FROM devices WHERE key_prefix = $1 AND revoked = FALSE',
    [match[1]]
  );
  for (const d of rows) {
    if (await bcrypt.compare(key, d.key_hash)) {
      req.device = { id: d.id, name: d.name };
      return next();
    }
  }
  next(httpError(401, 'BAD_DEVICE_KEY', 'Невалиден ключ на устройството.'));
}

async function createUser({ email, password, name, role }) {
  const userId = id('usr');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await q(
    `INSERT INTO users (id,email,password_hash,name,role) VALUES ($1,$2,$3,$4,$5)
     RETURNING id,email,name,role,active,created_at`,
    [userId, String(email).toLowerCase().trim(), hash, name, role]
  );
  return rows[0];
}

module.exports = {
  signToken, loadUser, requireRole, requireDevice,
  generateDeviceKey, createUser, bcrypt, ROLE_RANK,
};
