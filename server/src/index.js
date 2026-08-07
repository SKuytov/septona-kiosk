'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const compression = require('compression');

const { init, q } = require('./db');
const { loadUser, createUser } = require('./auth');
const { audit } = require('./audit');

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

app.set('trust proxy', true);
app.use(compression());
app.use(cors({ origin: true, exposedHeaders: ['ETag'] }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(loadUser);

app.get('/api/health', async (_req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, service: 'septona-kiosk', time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.use('/api/kiosk', require('./routes/kiosk'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/content'));

// Admin SPA (built into admin/dist) served from the same origin.
const ADMIN_DIST = process.env.ADMIN_DIST || path.join(__dirname, '../../admin/dist');
if (fs.existsSync(ADMIN_DIST)) {
  app.use(express.static(ADMIN_DIST, { index: false }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(ADMIN_DIST, 'index.html')));
}

app.use((_req, res) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ресурсът не е намерен.' } }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: status >= 500 ? 'Вътрешна грешка на сървъра.' : err.message,
      ...(err.code === 'DUPLICATE_CONTENT' ? { detail: err.detail } : {}),
    },
  });
});

/** First boot: create the initial admin so the panel is reachable. */
async function bootstrapAdmin() {
  const { rows } = await q('SELECT COUNT(*)::int AS count FROM users');
  if (rows[0].count > 0) return;
  const email = process.env.ADMIN_EMAIL || 'admin@septona.local';
  const password = process.env.ADMIN_PASSWORD || 'septona-admin';
  const user = await createUser({ email, password, name: 'Администратор', role: 'admin' });
  await audit(null, { action: 'user.create', entity: 'user', entityId: user.id,
    summary: `Създаден първоначален администратор ${email}` });
  console.log(`[bootstrap] admin created: ${email} / ${password}  — change this password`);
}

(async () => {
  await init();
  await bootstrapAdmin();
  app.listen(PORT, '0.0.0.0', () => console.log(`[septona-kiosk] listening on :${PORT}`));
})().catch((e) => {
  console.error('[fatal] startup failed', e);
  process.exit(1);
});
