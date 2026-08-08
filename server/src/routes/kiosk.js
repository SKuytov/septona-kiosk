'use strict';
const express = require('express');
const { q, getSettings } = require('../db');
const { requireDevice } = require('../auth');
const { asyncH, httpError } = require('../util');
const storage = require('../storage');

const router = express.Router();
router.use(requireDevice);

/**
 * Everything a display needs to render its entire UI offline, minus PDF bytes.
 * Only visible categories and live documents that actually have a file.
 */
router.get('/manifest', asyncH(async (req, res) => {
  const settings = await getSettings();
  const { rows: [{ manifest_version }] } = await q('SELECT manifest_version FROM content_state WHERE id = 1');

  const { rows: cats } = await q(
    'SELECT * FROM categories WHERE visible = TRUE ORDER BY sort_order, name_bg');

  const { rows: docs } = await q(`
    SELECT d.*, v.id AS ver_id, v.version_number, v.sha256, v.size_bytes, v.page_count, v.created_at AS ver_at
    FROM documents d
    JOIN document_versions v ON v.id = d.current_version_id
    JOIN categories c ON c.id = d.category_id
    WHERE d.deleted_at IS NULL AND c.visible = TRUE
    ORDER BY d.pinned DESC, d.sort_order, d.title_bg`);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    manifestVersion: manifest_version,
    generatedAt: new Date().toISOString(),
    settings: {
      kioskTitle: settings.kioskTitle,
      defaultLanguage: settings.defaultLanguage,
      homeAfterIdleSeconds: settings.homeAfterIdleSeconds,
      syncIntervalMinutes: settings.syncIntervalMinutes,
    },
    categories: cats.map((c) => ({
      id: c.id, slug: c.slug, nameBg: c.name_bg, nameEn: c.name_en, icon: c.icon,
      colour: c.colour, sortOrder: c.sort_order,
      visible: c.visible, parentId: c.parent_id,
    })),
    documents: docs.map((d) => ({
      id: d.id, categoryId: d.category_id, titleBg: d.title_bg, titleEn: d.title_en,
      language: d.language, tags: d.tags || [], sortOrder: d.sort_order, pinned: d.pinned,
      versionId: d.ver_id, versionNumber: d.version_number, sha256: d.sha256,
      sizeBytes: Number(d.size_bytes), pageCount: d.page_count,
      updatedAt: d.ver_at, fileUrl: `/api/kiosk/file/${d.ver_id}`,
    })),
  });
}));

/** Version bytes are immutable, so the kiosk may cache these forever. */
router.get('/file/:versionId', asyncH(async (req, res) => {
  const { rows } = await q('SELECT * FROM document_versions WHERE id = $1', [req.params.versionId]);
  if (!rows.length || !storage.existsStored(rows[0].stored_path))
    throw httpError(404, 'NOT_FOUND', 'Файлът не е намерен.');
  const v = rows[0];
  const etag = `"${v.sha256}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('ETag', etag);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(v.size_bytes));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(storage.absPath(v.stored_path));
}));

router.post('/heartbeat', asyncH(async (req, res) => {
  const b = req.body || {};
  await q(
    `UPDATE devices SET last_seen_at = now(), last_manifest_version = $1,
     docs_cached = $2, storage_bytes = $3, app_version = $4 WHERE id = $5`,
    [b.manifestVersion ?? null, b.docsCached ?? null, b.storageBytes ?? null,
     b.appVersion ?? null, req.device.id]);
  res.json({ ok: true });
}));

module.exports = router;
