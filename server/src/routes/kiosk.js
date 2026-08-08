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

  /* A document carries up to two files, one per language, and appears here if it has at
   * least one. The panel picks the file for the language it is showing and hides the
   * document when that language is missing. */
  const { rows: docs } = await q(`
    SELECT d.*,
      b.id AS bg_id, b.version_number AS bg_no, b.sha256 AS bg_sha, b.size_bytes AS bg_size,
      b.page_count AS bg_pages, b.created_at AS bg_at,
      e.id AS en_id, e.version_number AS en_no, e.sha256 AS en_sha, e.size_bytes AS en_size,
      e.page_count AS en_pages, e.created_at AS en_at
    FROM documents d
    LEFT JOIN document_versions b ON b.id = d.current_version_bg
    LEFT JOIN document_versions e ON e.id = d.current_version_en
    JOIN categories c ON c.id = d.category_id
    WHERE d.deleted_at IS NULL AND c.visible = TRUE
      AND (d.current_version_bg IS NOT NULL OR d.current_version_en IS NOT NULL)
    ORDER BY d.pinned DESC, d.sort_order, d.title_bg`);

  const file = (d, l) => (d[`${l}_id`] ? {
    versionId: d[`${l}_id`], versionNumber: d[`${l}_no`], sha256: d[`${l}_sha`],
    sizeBytes: Number(d[`${l}_size`]), pageCount: d[`${l}_pages`], updatedAt: d[`${l}_at`],
    fileUrl: `/api/kiosk/file/${d[`${l}_id`]}`,
  } : null);

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
    documents: docs.map((d) => {
      const files = { bg: file(d, 'bg'), en: file(d, 'en') };
      // Panels running an older build know only one file per document; give them the
      // Bulgarian one, or the English one when that is all there is.
      const legacy = files.bg || files.en;
      return {
        id: d.id, categoryId: d.category_id, titleBg: d.title_bg, titleEn: d.title_en,
        language: d.language, tags: d.tags || [], sortOrder: d.sort_order, pinned: d.pinned,
        files,
        versionId: legacy.versionId, versionNumber: legacy.versionNumber,
        sha256: legacy.sha256, sizeBytes: legacy.sizeBytes, pageCount: legacy.pageCount,
        updatedAt: legacy.updatedAt, fileUrl: legacy.fileUrl,
      };
    }),
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
