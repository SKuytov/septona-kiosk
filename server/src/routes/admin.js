'use strict';
const express = require('express');
const { q, getSettings, bumpManifest } = require('../db');
const { audit } = require('../audit');
const {
  signToken, requireRole, createUser, generateDeviceKey, bcrypt,
} = require('../auth');
const { id, asyncH, httpError } = require('../util');

const router = express.Router();

// ---------------------------------------------------------------------- auth

router.post('/auth/login', asyncH(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const password = String(req.body?.password || '');
  const { rows } = await q('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  const ok = user && user.active && (await bcrypt.compare(password, user.password_hash));
  if (!ok) {
    await audit(req, { action: 'auth.login.failed', entity: 'user', entityId: user?.id,
      summary: `Неуспешен опит за вписване: ${email}` });
    throw httpError(401, 'BAD_CREDENTIALS', 'Грешен имейл или парола.');
  }
  req.user = user;
  await audit(req, { action: 'auth.login', entity: 'user', entityId: user.id,
    summary: `Вписване: ${user.name}` });
  res.json({
    token: signToken(user),
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
}));

router.get('/auth/me', requireRole('viewer'), (req, res) => res.json({ user: req.user }));

router.post('/auth/password', requireRole('viewer'), asyncH(async (req, res) => {
  const { rows } = await q('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body?.current || ''), rows[0].password_hash)))
    throw httpError(400, 'BAD_PASSWORD', 'Текущата парола е грешна.');
  if (String(req.body?.next || '').length < 8)
    throw httpError(400, 'WEAK_PASSWORD', 'Новата парола трябва да е поне 8 знака.');
  await q('UPDATE users SET password_hash = $1 WHERE id = $2',
    [await bcrypt.hash(req.body.next, 10), req.user.id]);
  await audit(req, { action: 'user.update', entity: 'user', entityId: req.user.id,
    summary: 'Смяна на собствена парола' });
  res.json({ ok: true });
}));

// --------------------------------------------------------------------- users

const userOut = (r) => ({ id: r.id, email: r.email, name: r.name, role: r.role,
  active: r.active, createdAt: r.created_at });

router.get('/users', requireRole('admin'), asyncH(async (_req, res) => {
  const { rows } = await q('SELECT * FROM users ORDER BY created_at');
  res.json({ users: rows.map(userOut) });
}));

router.post('/users', requireRole('admin'), asyncH(async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || !name) throw httpError(400, 'MISSING_FIELDS', 'Попълнете всички полета.');
  if (String(password).length < 8) throw httpError(400, 'WEAK_PASSWORD', 'Паролата трябва да е поне 8 знака.');
  if (!['admin', 'editor', 'viewer'].includes(role)) throw httpError(400, 'BAD_ROLE', 'Невалидна роля.');
  const { rows: dup } = await q('SELECT 1 FROM users WHERE email = $1', [String(email).toLowerCase().trim()]);
  if (dup.length) throw httpError(409, 'EMAIL_TAKEN', 'Този имейл вече е използван.');
  const user = await createUser({ email, password, name, role });
  await audit(req, { action: 'user.create', entity: 'user', entityId: user.id,
    summary: `Създаден потребител ${user.name} (${user.role})`, after: userOut(user) });
  res.status(201).json({ user: userOut(user) });
}));

router.patch('/users/:userId', requireRole('admin'), asyncH(async (req, res) => {
  const { rows: cur } = await q('SELECT * FROM users WHERE id = $1', [req.params.userId]);
  if (!cur.length) throw httpError(404, 'NOT_FOUND', 'Потребителят не е намерен.');
  const sets = [], vals = [];
  for (const [k, col] of Object.entries({ name: 'name', role: 'role', active: 'active' }))
    if (req.body[k] !== undefined) { vals.push(req.body[k]); sets.push(`${col} = $${vals.length}`); }
  if (req.body.password) {
    if (String(req.body.password).length < 8) throw httpError(400, 'WEAK_PASSWORD', 'Паролата трябва да е поне 8 знака.');
    vals.push(await bcrypt.hash(req.body.password, 10));
    sets.push(`password_hash = $${vals.length}`);
  }
  if (req.params.userId === req.user.id && req.body.active === false)
    throw httpError(400, 'CANNOT_DISABLE_SELF', 'Не можете да деактивирате собствения си профил.');
  if (!sets.length) return res.json({ user: userOut(cur[0]) });
  vals.push(req.params.userId);
  const { rows } = await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  await audit(req, { action: 'user.update', entity: 'user', entityId: req.params.userId,
    summary: `Обновен потребител ${rows[0].name}`, before: userOut(cur[0]), after: userOut(rows[0]) });
  res.json({ user: userOut(rows[0]) });
}));

router.delete('/users/:userId', requireRole('admin'), asyncH(async (req, res) => {
  if (req.params.userId === req.user.id)
    throw httpError(400, 'CANNOT_DELETE_SELF', 'Не можете да изтриете собствения си профил.');
  const { rows } = await q('DELETE FROM users WHERE id = $1 RETURNING *', [req.params.userId]);
  if (!rows.length) throw httpError(404, 'NOT_FOUND', 'Потребителят не е намерен.');
  await audit(req, { action: 'user.delete', entity: 'user', entityId: req.params.userId,
    summary: `Изтрит потребител ${rows[0].name}`, before: userOut(rows[0]) });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------- devices

const devOut = (r) => ({ id: r.id, name: r.name, location: r.location,
  keyPrefix: r.key_prefix, revoked: r.revoked, createdAt: r.created_at,
  lastSeenAt: r.last_seen_at, lastManifestVersion: r.last_manifest_version,
  docsCached: r.docs_cached, storageBytes: r.storage_bytes != null ? Number(r.storage_bytes) : null,
  appVersion: r.app_version });

router.get('/devices', requireRole('admin'), asyncH(async (_req, res) => {
  const { rows } = await q('SELECT * FROM devices ORDER BY created_at');
  res.json({ devices: rows.map(devOut) });
}));

router.post('/devices', requireRole('admin'), asyncH(async (req, res) => {
  if (!req.body?.name) throw httpError(400, 'NAME_REQUIRED', 'Въведете име на устройството.');
  const { key, prefix } = generateDeviceKey();
  const devId = id('dev');
  const { rows } = await q(
    `INSERT INTO devices (id,name,location,key_hash,key_prefix) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [devId, req.body.name, req.body.location || null, await bcrypt.hash(key, 10), prefix]);
  await audit(req, { action: 'device.create', entity: 'device', entityId: devId,
    summary: `Регистрирано устройство «${req.body.name}»`, after: devOut(rows[0]) });
  // The plaintext key is returned exactly once and never stored.
  res.status(201).json({ device: devOut(rows[0]), key });
}));

router.delete('/devices/:deviceId', requireRole('admin'), asyncH(async (req, res) => {
  const { rows } = await q(
    'UPDATE devices SET revoked = TRUE WHERE id = $1 RETURNING *', [req.params.deviceId]);
  if (!rows.length) throw httpError(404, 'NOT_FOUND', 'Устройството не е намерено.');
  await audit(req, { action: 'device.revoke', entity: 'device', entityId: req.params.deviceId,
    summary: `Отнет достъп на устройство «${rows[0].name}»`, before: devOut(rows[0]) });
  res.json({ ok: true });
}));

// --------------------------------------------------------------------- audit

router.get('/audit', requireRole('viewer'), asyncH(async (req, res) => {
  const where = ['1=1'], vals = [];
  for (const [param, col] of Object.entries({ entity: 'entity', entityId: 'entity_id', actorId: 'actor_id', action: 'action' }))
    if (req.query[param]) { vals.push(req.query[param]); where.push(`${col} = $${vals.length}`); }
  if (req.query.from) { vals.push(req.query.from); where.push(`at >= $${vals.length}`); }
  if (req.query.to) { vals.push(req.query.to); where.push(`at <= $${vals.length}`); }
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize || '50', 10)));
  const { rows: [{ count }] } = await q(
    `SELECT COUNT(*)::int AS count FROM audit_log WHERE ${where.join(' AND ')}`, vals);
  const { rows } = await q(
    `SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, vals);
  res.json({
    entries: rows.map((r) => ({ id: Number(r.id), at: r.at, actorType: r.actor_type,
      actorId: r.actor_id, actorName: r.actor_name, action: r.action, entity: r.entity,
      entityId: r.entity_id, summary: r.summary, before: r.before, after: r.after, ip: r.ip })),
    total: count, page, pageSize,
  });
}));

// ------------------------------------------------------------------ settings

router.get('/settings', requireRole('viewer'), asyncH(async (_req, res) =>
  res.json({ settings: await getSettings() })));

// A number typed into the panel's timing fields reaches every display, so keep the values
// inside a range that still leaves the panel usable.
const NUMERIC_LIMITS = { homeAfterIdleSeconds: [15, 3600], syncIntervalMinutes: [1, 1440] };

router.patch('/settings', requireRole('admin'), asyncH(async (req, res) => {
  const before = await getSettings();
  for (const [key, raw] of Object.entries(req.body || {})) {
    if (!(key in before)) continue;
    let value = raw;
    if (NUMERIC_LIMITS[key]) {
      const [lo, hi] = NUMERIC_LIMITS[key];
      const n = Number(value);
      if (!Number.isFinite(n)) throw httpError(400, 'BAD_VALUE', `«${key}» трябва да е число.`);
      value = Math.min(hi, Math.max(lo, Math.round(n)));
    }
    await q('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(value)]);
  }
  await bumpManifest();
  const after = await getSettings();
  await audit(req, { action: 'settings.update', entity: 'settings',
    summary: 'Обновени настройки на киоска', before, after });
  res.json({ settings: after });
}));

// --------------------------------------------------------------------- stats

router.get('/stats', requireRole('viewer'), asyncH(async (_req, res) => {
  const { rows: [s] } = await q(`
    SELECT
      (SELECT COUNT(*) FROM categories)::int AS categories,
      (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL)::int AS documents,
      (SELECT COUNT(*) FROM document_versions)::int AS versions,
      (SELECT COUNT(*) FROM devices WHERE revoked = FALSE)::int AS devices,
      (SELECT COUNT(*) FROM devices WHERE revoked = FALSE AND last_seen_at > now() - interval '1 hour')::int AS devices_online,
      (SELECT COUNT(*) FROM users WHERE active)::int AS users,
      (SELECT COALESCE(SUM(size_bytes),0) FROM document_versions)::bigint AS storage_bytes,
      (SELECT manifest_version FROM content_state WHERE id = 1) AS manifest_version`);
  const { rows: recent } = await q('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT 10');
  res.json({
    stats: { categories: s.categories, documents: s.documents, versions: s.versions,
      devices: s.devices, devicesOnline: s.devices_online, users: s.users,
      storageBytes: Number(s.storage_bytes), manifestVersion: s.manifest_version },
    recentActivity: recent.map((r) => ({ id: Number(r.id), at: r.at, actorName: r.actor_name,
      action: r.action, summary: r.summary })),
  });
}));

module.exports = router;
