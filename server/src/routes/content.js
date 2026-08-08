'use strict';
const express = require('express');
const multer = require('multer');
const { q, tx, bumpManifest, getSettings } = require('../db');
const { audit } = require('../audit');
const { requireRole } = require('../auth');
const { id, slugify, httpError, asyncH, pdfPageCount } = require('../util');
const storage = require('../storage');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const catOut = (r) => ({
  id: r.id, slug: r.slug, nameBg: r.name_bg, nameEn: r.name_en, icon: r.icon,
  colour: r.colour, sortOrder: r.sort_order, cycleSeconds: r.cycle_seconds,
  visible: r.visible, parentId: r.parent_id, documentCount: Number(r.document_count ?? 0),
});

const verOut = (r) => ({
  id: r.id, versionNumber: r.version_number, filename: r.filename, sha256: r.sha256,
  sizeBytes: Number(r.size_bytes), pageCount: r.page_count, note: r.note,
  sourceFilename: r.source_filename, converted: r.converted,
  uploadedBy: r.uploaded_by, uploadedByName: r.uploaded_by_name, createdAt: r.created_at,
});

const docOut = (r) => ({
  id: r.id, categoryId: r.category_id, titleBg: r.title_bg, titleEn: r.title_en,
  language: r.language, tags: r.tags || [], sortOrder: r.sort_order, pinned: r.pinned,
  versionId: r.current_version_id, versionNumber: r.version_number,
  sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
  pageCount: r.page_count, sha256: r.sha256,
  createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
});

// ---------------------------------------------------------------- categories

router.get('/categories', requireRole('viewer'), asyncH(async (_req, res) => {
  const { rows } = await q(`
    SELECT c.*, (SELECT COUNT(*) FROM documents d
                  WHERE d.category_id = c.id AND d.deleted_at IS NULL) AS document_count
    FROM categories c ORDER BY c.sort_order, c.name_bg`);
  res.json({ categories: rows.map(catOut) });
}));

router.post('/categories', requireRole('editor'), asyncH(async (req, res) => {
  const b = req.body || {};
  if (!b.nameBg || !String(b.nameBg).trim())
    throw httpError(400, 'NAME_REQUIRED', 'Името на категорията е задължително.');
  const catId = id('cat');
  let slug = slugify(b.nameBg);
  const { rows: clash } = await q('SELECT 1 FROM categories WHERE slug = $1', [slug]);
  if (clash.length) slug = `${slug}-${catId.slice(-4)}`;
  const { rows } = await q(
    `INSERT INTO categories (id,slug,name_bg,name_en,icon,colour,sort_order,cycle_seconds,visible,parent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [catId, slug, String(b.nameBg).trim(), b.nameEn || '', b.icon || 'doc',
     b.colour || '#26307A', b.sortOrder ?? 999, b.cycleSeconds ?? null,
     b.visible !== false, b.parentId || null]
  );
  await bumpManifest();
  await audit(req, { action: 'category.create', entity: 'category', entityId: catId,
    summary: `Създадена категория «${rows[0].name_bg}»`, after: catOut(rows[0]) });
  res.status(201).json({ category: catOut(rows[0]) });
}));

router.patch('/categories/:catId', requireRole('editor'), asyncH(async (req, res) => {
  const { rows: cur } = await q('SELECT * FROM categories WHERE id = $1', [req.params.catId]);
  if (!cur.length) throw httpError(404, 'NOT_FOUND', 'Категорията не е намерена.');
  const map = { nameBg: 'name_bg', nameEn: 'name_en', icon: 'icon', colour: 'colour',
    sortOrder: 'sort_order', cycleSeconds: 'cycle_seconds', visible: 'visible', parentId: 'parent_id' };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (req.body[k] !== undefined) { vals.push(req.body[k]); sets.push(`${col} = $${vals.length}`); }
  }
  if (!sets.length) return res.json({ category: catOut(cur[0]) });
  if (req.body.parentId && req.body.parentId === req.params.catId)
    throw httpError(400, 'INVALID_PARENT', 'Категорията не може да бъде родител на себе си.');
  vals.push(req.params.catId);
  const { rows } = await q(
    `UPDATE categories SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
  await bumpManifest();
  await audit(req, { action: 'category.update', entity: 'category', entityId: req.params.catId,
    summary: `Обновена категория «${rows[0].name_bg}»`, before: catOut(cur[0]), after: catOut(rows[0]) });
  res.json({ category: catOut(rows[0]) });
}));

router.post('/categories/reorder', requireRole('editor'), asyncH(async (req, res) => {
  const order = req.body?.order;
  if (!Array.isArray(order)) throw httpError(400, 'BAD_ORDER', 'Очаква се списък с идентификатори.');
  await tx(async (c) => {
    for (let i = 0; i < order.length; i++)
      await c.query('UPDATE categories SET sort_order = $1, updated_at = now() WHERE id = $2', [(i + 1) * 10, order[i]]);
    await bumpManifest(c);
  });
  await audit(req, { action: 'category.reorder', entity: 'category',
    summary: `Пренаредени ${order.length} категории`, after: { order } });
  res.json({ ok: true });
}));

router.delete('/categories/:catId', requireRole('admin'), asyncH(async (req, res) => {
  const { rows: cur } = await q('SELECT * FROM categories WHERE id = $1', [req.params.catId]);
  if (!cur.length) throw httpError(404, 'NOT_FOUND', 'Категорията не е намерена.');
  const { rows: [{ count }] } = await q(
    'SELECT COUNT(*)::int AS count FROM documents WHERE category_id = $1 AND deleted_at IS NULL',
    [req.params.catId]);
  const reassignTo = req.query.reassignTo;
  if (count > 0 && !reassignTo)
    throw httpError(409, 'CATEGORY_NOT_EMPTY', `Категорията съдържа ${count} документа. Изберете къде да бъдат преместени.`);
  await tx(async (c) => {
    if (count > 0) {
      const { rows: t } = await c.query('SELECT 1 FROM categories WHERE id = $1', [reassignTo]);
      if (!t.length) throw httpError(400, 'BAD_TARGET', 'Целевата категория не съществува.');
      await c.query('UPDATE documents SET category_id = $1, updated_at = now() WHERE category_id = $2', [reassignTo, req.params.catId]);
    }
    await c.query('UPDATE categories SET parent_id = NULL WHERE parent_id = $1', [req.params.catId]);
    await c.query('DELETE FROM categories WHERE id = $1', [req.params.catId]);
    await bumpManifest(c);
  });
  await audit(req, { action: 'category.delete', entity: 'category', entityId: req.params.catId,
    summary: `Изтрита категория «${cur[0].name_bg}»${count ? ` (${count} документа преместени)` : ''}`,
    before: catOut(cur[0]) });
  res.json({ ok: true, movedDocuments: count });
}));

// ----------------------------------------------------------------- documents

const DOC_SELECT = `
  SELECT d.*, v.version_number, v.size_bytes, v.page_count, v.sha256
  FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id`;

router.get('/documents', requireRole('viewer'), asyncH(async (req, res) => {
  /*
    Live documents by default. `deleted=only` is what the admin's archive view asks for, and
    it has to be a server filter rather than a client one: the list is paginated, so filtering
    the current page would show "3 archived" out of whatever happened to be on page one.
  */
  const deleted = req.query.deleted === 'only' ? 'only'
    : (req.query.deleted === 'include' || req.query.includeDeleted === 'true') ? 'include'
    : 'live';
  const where = [
    deleted === 'only' ? 'd.deleted_at IS NOT NULL'
      : deleted === 'include' ? '1=1'
      : 'd.deleted_at IS NULL',
  ];
  const vals = [];
  if (req.query.categoryId) { vals.push(req.query.categoryId); where.push(`d.category_id = $${vals.length}`); }
  if (req.query.language && req.query.language !== 'all') {
    vals.push(req.query.language); where.push(`(d.language = $${vals.length} OR d.language = 'both')`);
  }
  if (req.query.q) {
    vals.push(`%${req.query.q}%`);
    where.push(`(d.title_bg ILIKE $${vals.length} OR d.title_en ILIKE $${vals.length} OR array_to_string(d.tags,' ') ILIKE $${vals.length})`);
  }
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize || '50', 10)));
  const { rows: [{ count }] } = await q(
    `SELECT COUNT(*)::int AS count FROM documents d WHERE ${where.join(' AND ')}`, vals);
  const { rows } = await q(
    `${DOC_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY ${deleted === 'only' ? 'd.deleted_at DESC,' : ''} d.pinned DESC, d.sort_order, d.title_bg
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, vals);
  res.json({ documents: rows.map(docOut), total: count, page, pageSize });
}));

router.get('/documents/:docId', requireRole('viewer'), asyncH(async (req, res) => {
  const { rows } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
  if (!rows.length) throw httpError(404, 'NOT_FOUND', 'Документът не е намерен.');
  const { rows: versions } = await q(
    'SELECT * FROM document_versions WHERE document_id = $1 ORDER BY version_number DESC',
    [req.params.docId]);
  res.json({ document: { ...docOut(rows[0]), versions: versions.map(verOut) } });
}));

function parseMeta(req) {
  try { return req.body?.meta ? JSON.parse(req.body.meta) : (req.body || {}); }
  catch { throw httpError(400, 'BAD_META', 'Полето meta не е валиден JSON.'); }
}

/** Shared: validate + persist an uploaded file as a new version row. */
async function ingest(req, client, documentId, versionNumber, note) {
  if (!req.file) throw httpError(400, 'NO_FILE', 'Не е приложен файл.');
  const settings = await getSettings();
  const { buffer, converted } = await storage.toPdfBuffer(
    req.file.buffer, req.file.originalname, settings.allowOfficeConversion);

  if (req.query.allowDuplicate !== 'true') {
    const hash = require('../util').sha256(buffer);
    const { rows: dup } = await client.query(
      `SELECT v.document_id, d.title_bg FROM document_versions v
       JOIN documents d ON d.id = v.document_id
       WHERE v.sha256 = $1 AND d.deleted_at IS NULL AND v.id = d.current_version_id
       AND v.document_id <> $2 LIMIT 1`, [hash, documentId]);
    if (dup.length)
      throw httpError(409, 'DUPLICATE_CONTENT',
        `Идентичен файл вече съществува като «${dup[0].title_bg}».`);
  }

  const { hash, storedPath, sizeBytes } = storage.store(buffer);
  const versionId = id('ver');
  await client.query(
    `INSERT INTO document_versions
     (id,document_id,version_number,filename,stored_path,sha256,size_bytes,mime,page_count,note,source_filename,converted,uploaded_by,uploaded_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'application/pdf',$8,$9,$10,$11,$12,$13)`,
    [versionId, documentId, versionNumber, req.file.originalname.replace(/\.[^.]+$/, '') + '.pdf',
     storedPath, hash, sizeBytes, pdfPageCount(buffer), note || null,
     converted ? req.file.originalname : null, converted,
     req.user?.id || null, req.user?.name || null]
  );
  return { versionId, sizeBytes };
}

router.post('/documents', requireRole('editor'), upload.single('file'), asyncH(async (req, res) => {
  const meta = parseMeta(req);
  if (!meta.categoryId) throw httpError(400, 'CATEGORY_REQUIRED', 'Изберете категория.');
  const { rows: cat } = await q('SELECT 1 FROM categories WHERE id = $1', [meta.categoryId]);
  if (!cat.length) throw httpError(400, 'BAD_CATEGORY', 'Категорията не съществува.');

  const docId = id('doc');
  const titleBg = (meta.titleBg || req.file?.originalname?.replace(/\.[^.]+$/, '') || 'Без име').trim();
  const out = await tx(async (c) => {
    await c.query(
      `INSERT INTO documents (id,category_id,title_bg,title_en,language,tags,sort_order,pinned)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [docId, meta.categoryId, titleBg, meta.titleEn || '', meta.language || 'bg',
       meta.tags || [], meta.sortOrder ?? 999, !!meta.pinned]);
    const { versionId } = await ingest(req, c, docId, 1, meta.note || 'Първоначално качване');
    await c.query('UPDATE documents SET current_version_id = $1 WHERE id = $2', [versionId, docId]);
    await bumpManifest(c);
    const { rows } = await c.query(`${DOC_SELECT} WHERE d.id = $1`, [docId]);
    return rows[0];
  });
  await audit(req, { action: 'document.create', entity: 'document', entityId: docId,
    summary: `Качен документ «${titleBg}»`, after: docOut(out) });
  res.status(201).json({ document: docOut(out) });
}));

router.patch('/documents/:docId', requireRole('editor'), asyncH(async (req, res) => {
  const { rows: cur } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
  if (!cur.length) throw httpError(404, 'NOT_FOUND', 'Документът не е намерен.');
  const map = { categoryId: 'category_id', titleBg: 'title_bg', titleEn: 'title_en',
    language: 'language', tags: 'tags', sortOrder: 'sort_order', pinned: 'pinned' };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map))
    if (req.body[k] !== undefined) { vals.push(req.body[k]); sets.push(`${col} = $${vals.length}`); }
  if (!sets.length) return res.json({ document: docOut(cur[0]) });
  vals.push(req.params.docId);
  await q(`UPDATE documents SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
  await bumpManifest();
  const { rows } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
  await audit(req, { action: 'document.update', entity: 'document', entityId: req.params.docId,
    summary: `Обновени данни на «${rows[0].title_bg}»`, before: docOut(cur[0]), after: docOut(rows[0]) });
  res.json({ document: docOut(rows[0]) });
}));

router.post('/documents/:docId/versions', requireRole('editor'), upload.single('file'),
  asyncH(async (req, res) => {
    const { rows: cur } = await q('SELECT * FROM documents WHERE id = $1', [req.params.docId]);
    if (!cur.length) throw httpError(404, 'NOT_FOUND', 'Документът не е намерен.');
    const { rows: [{ max }] } = await q(
      'SELECT COALESCE(MAX(version_number),0) AS max FROM document_versions WHERE document_id = $1',
      [req.params.docId]);
    const next = Number(max) + 1;
    await tx(async (c) => {
      const { versionId } = await ingest(req, c, req.params.docId, next, req.body?.note);
      await c.query('UPDATE documents SET current_version_id = $1, updated_at = now() WHERE id = $2',
        [versionId, req.params.docId]);
      await bumpManifest(c);
    });
    const { rows } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
    await audit(req, { action: 'document.version.create', entity: 'document', entityId: req.params.docId,
      summary: `Качена версия ${next} на «${cur[0].title_bg}»`,
      before: { versionNumber: next - 1 }, after: { versionNumber: next, note: req.body?.note || null } });
    res.status(201).json({ document: docOut(rows[0]) });
  }));

router.post('/documents/:docId/versions/:versionId/restore', requireRole('editor'),
  asyncH(async (req, res) => {
    const { rows: v } = await q(
      'SELECT * FROM document_versions WHERE id = $1 AND document_id = $2',
      [req.params.versionId, req.params.docId]);
    if (!v.length) throw httpError(404, 'NOT_FOUND', 'Версията не е намерена.');
    const { rows: cur } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
    await tx(async (c) => {
      await c.query('UPDATE documents SET current_version_id = $1, updated_at = now() WHERE id = $2',
        [req.params.versionId, req.params.docId]);
      await bumpManifest(c);
    });
    await audit(req, { action: 'document.version.restore', entity: 'document', entityId: req.params.docId,
      summary: `Възстановена версия ${v[0].version_number} на «${cur[0].title_bg}»`,
      before: { versionNumber: cur[0].version_number }, after: { versionNumber: v[0].version_number } });
    const { rows } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
    res.json({ document: docOut(rows[0]) });
  }));

/**
 * Two different operations behind one verb, and the difference matters:
 *
 *   archive (default)  — the document leaves the kiosks and the document list, and every
 *                        version and its audit trail stay exactly where they are. Reversible
 *                        with POST /documents/:id/restore.
 *   hard=true          — the rows go, and so do the PDF files on disk. Not reversible.
 *
 * Permanent deletion used to leave the files behind: the database rows went, and the PDFs
 * stayed under data/files forever, so a policy that had been "deleted" was still readable by
 * anyone with the path. Since storage is content-addressed a blob can be shared by two
 * documents holding an identical file, so each one is removed only once nothing else refers
 * to it.
 */
router.delete('/documents/:docId', requireRole('admin'), asyncH(async (req, res) => {
  const { rows: cur } = await q('SELECT * FROM documents WHERE id = $1', [req.params.docId]);
  if (!cur.length) throw httpError(404, 'NOT_FOUND', 'Документът не е намерен.');
  const hard = req.query.hard === 'true';
  let filesRemoved = 0;
  let versions = 0;
  if (hard) {
    // Collected before the delete, checked for other owners after it, so the check sees the
    // rows that survive rather than the ones on their way out.
    const { rows: blobs } = await q(
      'SELECT id, stored_path, sha256 FROM document_versions WHERE document_id = $1',
      [req.params.docId]);
    versions = blobs.length;
    await tx(async (c) => {
      await c.query('DELETE FROM documents WHERE id = $1', [req.params.docId]);
      await bumpManifest(c);
    });
    const seen = new Set();
    for (const b of blobs) {
      if (seen.has(b.sha256)) continue;
      seen.add(b.sha256);
      const { rows: other } = await q(
        'SELECT 1 FROM document_versions WHERE sha256 = $1 LIMIT 1', [b.sha256]);
      if (other.length) continue; // another document holds the same bytes
      if (storage.removeStored(b.stored_path)) filesRemoved++;
    }
  } else {
    await tx(async (c) => {
      await c.query('UPDATE documents SET deleted_at = now() WHERE id = $1', [req.params.docId]);
      await bumpManifest(c);
    });
  }
  await audit(req, { action: hard ? 'document.purge' : 'document.delete', entity: 'document',
    entityId: req.params.docId,
    summary: hard
      ? `Окончателно изтрит документ «${cur[0].title_bg}» — ${versions} ${versions === 1 ? 'версия' : 'версии'}, ${filesRemoved === 1 ? '1 файл премахнат' : `${filesRemoved} файла премахнати`} от диска`
      : `Архивиран документ «${cur[0].title_bg}»`,
    before: { titleBg: cur[0].title_bg, versions } });
  // The archive path reports only what it did. Returning versions:0, filesRemoved:0 for an
  // archive reads as "nothing was kept" when the opposite is true.
  res.json(hard ? { ok: true, hard: true, versions, filesRemoved } : { ok: true, hard: false });
}));

router.post('/documents/:docId/restore', requireRole('editor'), asyncH(async (req, res) => {
  const { rows: cur } = await q('SELECT * FROM documents WHERE id = $1', [req.params.docId]);
  if (!cur.length) throw httpError(404, 'NOT_FOUND', 'Документът не е намерен.');
  await q('UPDATE documents SET deleted_at = NULL, updated_at = now() WHERE id = $1', [req.params.docId]);
  await bumpManifest();
  await audit(req, { action: 'document.restore', entity: 'document', entityId: req.params.docId,
    // The title belongs in the summary: the audit page reads as a sentence, and "restored a
    // document from the archive" with no name in it tells a later reader nothing.
    summary: `Възстановен от архива документ «${cur[0].title_bg}»`,
    after: { titleBg: cur[0].title_bg } });
  res.json({ ok: true });
}));

/** Inline preview of any version, current or historical. */
router.get('/documents/:docId/versions/:versionId/file', requireRole('viewer'),
  asyncH(async (req, res) => {
    const { rows } = await q(
      'SELECT * FROM document_versions WHERE id = $1 AND document_id = $2',
      [req.params.versionId, req.params.docId]);
    if (!rows.length || !storage.existsStored(rows[0].stored_path))
      throw httpError(404, 'NOT_FOUND', 'Файлът не е намерен.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].filename)}`);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(storage.absPath(rows[0].stored_path));
  }));

module.exports = router;
