'use strict';
const express = require('express');
const multer = require('multer');
const { q, tx, bumpManifest, refreshDocumentLanguage } = require('../db');
const { audit } = require('../audit');
const { requireRole } = require('../auth');
const { id, slugify, httpError, asyncH, pdfPageCount } = require('../util');
const storage = require('../storage');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const catOut = (r) => ({
  id: r.id, slug: r.slug, nameBg: r.name_bg, nameEn: r.name_en, icon: r.icon,
  colour: r.colour, sortOrder: r.sort_order,
  visible: r.visible, parentId: r.parent_id, documentCount: Number(r.document_count ?? 0),
});

const verOut = (r) => ({
  id: r.id, language: r.language, versionNumber: r.version_number,
  filename: r.filename, sha256: r.sha256,
  sizeBytes: Number(r.size_bytes), pageCount: r.page_count, note: r.note,
  sourceFilename: r.source_filename, converted: r.converted,
  uploadedBy: r.uploaded_by, uploadedByName: r.uploaded_by_name, createdAt: r.created_at,
});

/* One file per language, each with its own current version. `files.bg` or `files.en` is
 * null when that language has not been uploaded. The flat `versionId` / `versionNumber`
 * fields describe whichever language is present, preferring Bulgarian, so older callers
 * and the document list keep working unchanged. */
const slot = (r, lang) => (r[`${lang}_ver_id`] ? {
  versionId: r[`${lang}_ver_id`],
  versionNumber: r[`${lang}_version_number`],
  sizeBytes: r[`${lang}_size_bytes`] != null ? Number(r[`${lang}_size_bytes`]) : null,
  pageCount: r[`${lang}_page_count`],
  sha256: r[`${lang}_sha256`],
  filename: r[`${lang}_filename`],
  updatedAt: r[`${lang}_created_at`],
} : null);

const docOut = (r) => {
  const files = { bg: slot(r, 'bg'), en: slot(r, 'en') };
  const primary = files.bg || files.en;
  return {
    id: r.id, categoryId: r.category_id, titleBg: r.title_bg, titleEn: r.title_en,
    language: r.language, tags: r.tags || [], sortOrder: r.sort_order, pinned: r.pinned,
    files,
    versionId: primary ? primary.versionId : null,
    versionNumber: primary ? primary.versionNumber : null,
    sizeBytes: primary ? primary.sizeBytes : null,
    pageCount: primary ? primary.pageCount : null,
    sha256: primary ? primary.sha256 : null,
    createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
  };
};

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
    `INSERT INTO categories (id,slug,name_bg,name_en,icon,colour,sort_order,visible,parent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [catId, slug, String(b.nameBg).trim(), b.nameEn || '', b.icon || 'doc',
     b.colour || '#26307A', b.sortOrder ?? 999,
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
    sortOrder: 'sort_order', visible: 'visible', parentId: 'parent_id' };
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
  SELECT d.*,
    b.id AS bg_ver_id, b.version_number AS bg_version_number, b.size_bytes AS bg_size_bytes,
    b.page_count AS bg_page_count, b.sha256 AS bg_sha256, b.filename AS bg_filename,
    b.created_at AS bg_created_at,
    e.id AS en_ver_id, e.version_number AS en_version_number, e.size_bytes AS en_size_bytes,
    e.page_count AS en_page_count, e.sha256 AS en_sha256, e.filename AS en_filename,
    e.created_at AS en_created_at
  FROM documents d
  LEFT JOIN document_versions b ON b.id = d.current_version_bg
  LEFT JOIN document_versions e ON e.id = d.current_version_en`;

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
    // Filter on the files that exist, not on a label: a document counts as English when
    // it actually has an English PDF.
    where.push(req.query.language === 'en' ? 'd.current_version_en IS NOT NULL'
      : req.query.language === 'both'
        ? 'd.current_version_bg IS NOT NULL AND d.current_version_en IS NOT NULL'
        : 'd.current_version_bg IS NOT NULL');
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
    `SELECT * FROM document_versions WHERE document_id = $1
     ORDER BY language, version_number DESC`, [req.params.docId]);
  res.json({ document: { ...docOut(rows[0]), versions: versions.map(verOut) } });
}));

function parseMeta(req) {
  try { return req.body?.meta ? JSON.parse(req.body.meta) : (req.body || {}); }
  catch { throw httpError(400, 'BAD_META', 'Полето meta не е валиден JSON.'); }
}

/** The language a request is talking about. Bulgarian unless it says otherwise. */
function wantedLanguage(req) {
  const raw = (req.query.language || req.body?.language
    || (() => { try { return JSON.parse(req.body?.meta || '{}').language; } catch { return null; } })()
    || 'bg').toString().toLowerCase();
  if (raw !== 'bg' && raw !== 'en')
    throw httpError(400, 'BAD_LANGUAGE', 'Езикът трябва да е bg или en.');
  return raw;
}

/** Shared: validate + persist an uploaded file as a new version row. */
async function ingest(req, client, documentId, versionNumber, note, language, file) {
  const src = file || req.file;
  if (!src) throw httpError(400, 'NO_FILE', 'Не е приложен файл.');
  // Uploads through the interface are PDF-only, deliberately: a Word file converted on
  // the server is a different document from the one the author approved, and nobody
  // would notice the difference until it was on a wall. The converter stays available to
  // the one-off archive importer only.
  const { buffer, converted } = await storage.toPdfBuffer(
    src.buffer, src.originalname, false);

  if (req.query.allowDuplicate !== 'true') {
    const hash = require('../util').sha256(buffer);
    const { rows: dup } = await client.query(
      `SELECT v.document_id, d.title_bg FROM document_versions v
       JOIN documents d ON d.id = v.document_id
       WHERE v.sha256 = $1 AND d.deleted_at IS NULL
       AND v.id IN (d.current_version_bg, d.current_version_en)
       AND v.document_id <> $2 LIMIT 1`, [hash, documentId]);
    if (dup.length)
      // Two files can arrive together, so say which one is the problem.
      throw httpError(409, 'DUPLICATE_CONTENT',
        `${language === 'en' ? 'Английският' : 'Българският'} файл е идентичен с вече` +
        ` качен документ «${dup[0].title_bg}».`);
  }

  const { hash, storedPath, sizeBytes } = storage.store(buffer);
  const versionId = id('ver');
  await client.query(
    `INSERT INTO document_versions
     (id,document_id,language,version_number,filename,stored_path,sha256,size_bytes,mime,page_count,note,source_filename,converted,uploaded_by,uploaded_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'application/pdf',$9,$10,$11,$12,$13,$14)`,
    [versionId, documentId, language, versionNumber,
     src.originalname.replace(/\.[^.]+$/, '') + '.pdf',
     storedPath, hash, sizeBytes, pdfPageCount(buffer), note || null,
     converted ? src.originalname : null, converted,
     req.user?.id || null, req.user?.name || null]
  );
  return { versionId, sizeBytes };
}

/* A document can be created with its Bulgarian file, its English file, or both at once —
 * a policy that exists in two languages should not have to be entered twice. `file` on its
 * own is still accepted, and lands in the slot named by `language`. */
const createUpload = upload.fields([
  { name: 'file', maxCount: 1 }, { name: 'fileBg', maxCount: 1 }, { name: 'fileEn', maxCount: 1 },
]);

router.post('/documents', requireRole('editor'), createUpload, asyncH(async (req, res) => {
  const meta = parseMeta(req);
  if (!meta.categoryId) throw httpError(400, 'CATEGORY_REQUIRED', 'Изберете категория.');
  const { rows: cat } = await q('SELECT 1 FROM categories WHERE id = $1', [meta.categoryId]);
  if (!cat.length) throw httpError(400, 'BAD_CATEGORY', 'Категорията не съществува.');

  const picked = [];
  if (req.files?.fileBg?.[0]) picked.push(['bg', req.files.fileBg[0]]);
  if (req.files?.fileEn?.[0]) picked.push(['en', req.files.fileEn[0]]);
  if (!picked.length && req.files?.file?.[0])
    picked.push([wantedLanguage(req), req.files.file[0]]);
  if (!picked.length) throw httpError(400, 'NO_FILE', 'Приложете поне един PDF файл.');

  const docId = id('doc');
  const titleBg = (meta.titleBg || picked[0][1].originalname.replace(/\.[^.]+$/, '')
    || 'Без име').trim();
  const out = await tx(async (c) => {
    await c.query(
      `INSERT INTO documents (id,category_id,title_bg,title_en,language,tags,sort_order,pinned)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [docId, meta.categoryId, titleBg, meta.titleEn || '', picked[0][0],
       meta.tags || [], meta.sortOrder ?? 999, !!meta.pinned]);
    for (const [lang, file] of picked) {
      // eslint-disable-next-line no-await-in-loop
      const { versionId } = await ingest(
        req, c, docId, 1, meta.note || 'Първоначално качване', lang, file);
      // eslint-disable-next-line no-await-in-loop
      await c.query(
        `UPDATE documents SET current_version_${lang} = $1, current_version_id =
           COALESCE(current_version_id, $1) WHERE id = $2`, [versionId, docId]);
    }
    await refreshDocumentLanguage(c, docId);
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
    // Each language keeps its own run of version numbers, so adding an English file does
    // not renumber the Bulgarian one or disturb what the panels have cached.
    const lang = wantedLanguage(req);
    const { rows: [{ max }] } = await q(
      `SELECT COALESCE(MAX(version_number),0) AS max FROM document_versions
       WHERE document_id = $1 AND language = $2`, [req.params.docId, lang]);
    const next = Number(max) + 1;
    await tx(async (c) => {
      const { versionId } = await ingest(req, c, req.params.docId, next, req.body?.note, lang);
      await c.query(
        `UPDATE documents SET current_version_${lang} = $1, updated_at = now() WHERE id = $2`,
        [versionId, req.params.docId]);
      await refreshDocumentLanguage(c, req.params.docId);
      await bumpManifest(c);
    });
    const { rows } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
    const langName = lang === 'en' ? 'английската' : 'българската';
    await audit(req, { action: 'document.version.create', entity: 'document', entityId: req.params.docId,
      summary: next === 1
        ? `Качен ${lang === 'en' ? 'английски' : 'български'} файл към «${cur[0].title_bg}»`
        : `Качена версия ${next} на ${langName} версия на «${cur[0].title_bg}»`,
      before: { language: lang, versionNumber: next - 1 },
      after: { language: lang, versionNumber: next, note: req.body?.note || null } });
    res.status(201).json({ document: docOut(rows[0]) });
  }));

router.post('/documents/:docId/versions/:versionId/restore', requireRole('editor'),
  asyncH(async (req, res) => {
    const { rows: v } = await q(
      'SELECT * FROM document_versions WHERE id = $1 AND document_id = $2',
      [req.params.versionId, req.params.docId]);
    if (!v.length) throw httpError(404, 'NOT_FOUND', 'Версията не е намерена.');
    const { rows: cur } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
    // A restore only moves the chain the version belongs to; the other language is untouched.
    const lang = v[0].language;
    const wasNumber = cur[0][`${lang}_version_number`];
    await tx(async (c) => {
      await c.query(
        `UPDATE documents SET current_version_${lang} = $1, updated_at = now() WHERE id = $2`,
        [req.params.versionId, req.params.docId]);
      await refreshDocumentLanguage(c, req.params.docId);
      await bumpManifest(c);
    });
    const langName = lang === 'en' ? 'английската' : 'българската';
    await audit(req, { action: 'document.version.restore', entity: 'document', entityId: req.params.docId,
      summary: `Възстановена версия ${v[0].version_number} на ${langName} версия на «${cur[0].title_bg}»`,
      before: { language: lang, versionNumber: wasNumber },
      after: { language: lang, versionNumber: v[0].version_number } });
    const { rows } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
    res.json({ document: docOut(rows[0]) });
  }));

/**
 * Attach another document as this one's missing language.
 *
 * Before a document could hold two files, a policy published in both languages had to be
 * entered twice. This joins the two records: the other record's files move into the free
 * slot here, keeping their history, and that record is archived. It is also how a pair the
 * automatic merge would not risk guessing gets joined by hand.
 */
router.post('/documents/:docId/link-language', requireRole('editor'), asyncH(async (req, res) => {
  const sourceId = req.body?.sourceDocumentId;
  if (!sourceId) throw httpError(400, 'SOURCE_REQUIRED', 'Изберете документ за свързване.');
  if (sourceId === req.params.docId)
    throw httpError(400, 'SAME_DOCUMENT', 'Документът не може да се свърже със себе си.');

  const { rows: [target] } = await q(`${DOC_SELECT} WHERE d.id = $1 AND d.deleted_at IS NULL`,
    [req.params.docId]);
  if (!target) throw httpError(404, 'NOT_FOUND', 'Документът не е намерен.');
  // The free slot decides which language the source has to bring, so check it before
  // going looking for the source at all.
  const lang = !target.bg_ver_id ? 'bg' : !target.en_ver_id ? 'en' : null;
  if (!lang)
    throw httpError(409, 'BOTH_PRESENT',
      'Документът вече има файлове и на двата езика. Изтрийте единия, за да свържете друг.');

  const { rows: [source] } = await q(`${DOC_SELECT} WHERE d.id = $1 AND d.deleted_at IS NULL`,
    [sourceId]);
  if (!source) throw httpError(404, 'SOURCE_NOT_FOUND', 'Свързваният документ не е намерен.');
  if (!source[`${lang}_ver_id`])
    throw httpError(409, 'WRONG_LANGUAGE',
      `Избраният документ няма ${lang === 'en' ? 'английски' : 'български'} файл.`);
  if (source[lang === 'bg' ? 'en_ver_id' : 'bg_ver_id'])
    throw httpError(409, 'SOURCE_HAS_BOTH',
      'Избраният документ има файлове и на двата езика и не може да бъде присъединен.');

  await tx(async (c) => {
    // Move the version history across; it is already the only chain of its language there,
    // so the numbering carries over untouched.
    await c.query(
      'UPDATE document_versions SET document_id = $1 WHERE document_id = $2 AND language = $3',
      [req.params.docId, sourceId, lang]);
    await c.query(
      `UPDATE documents SET current_version_${lang} = $1, updated_at = now(),
         title_en = CASE WHEN title_en = '' THEN $2 ELSE title_en END
       WHERE id = $3`,
      [source[`${lang}_ver_id`], source.title_en || target.title_en || '', req.params.docId]);
    await refreshDocumentLanguage(c, req.params.docId);
    await c.query(
      `UPDATE documents SET deleted_at = now(), current_version_${lang} = NULL WHERE id = $1`,
      [sourceId]);
    await bumpManifest(c);
  });

  const { rows } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
  await audit(req, { action: 'document.link_language', entity: 'document',
    entityId: req.params.docId,
    summary: `«${source.title_bg}» беше присъединен като `
      + `${lang === 'en' ? 'английска' : 'българска'} версия на «${target.title_bg}»`,
    before: { linkedDocumentId: sourceId, title: source.title_bg },
    after: docOut(rows[0]) });
  res.json({ document: docOut(rows[0]) });
}));

/**
 * Detach one language back into a document of its own — the way back out of a link or an
 * automatic merge that paired the wrong two records.
 */
router.post('/documents/:docId/unlink-language', requireRole('editor'), asyncH(async (req, res) => {
  const lang = wantedLanguage(req);
  const { rows: [doc] } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
  if (!doc) throw httpError(404, 'NOT_FOUND', 'Документът не е намерен.');
  if (!doc.bg_ver_id || !doc.en_ver_id)
    throw httpError(409, 'NOT_PAIRED', 'Документът има файл само на един език.');

  const newId = id('doc');
  await tx(async (c) => {
    await c.query(
      `INSERT INTO documents (id,category_id,title_bg,title_en,language,tags,sort_order,pinned)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId, doc.category_id, doc.title_bg, doc.title_en, lang, doc.tags || [],
       doc.sort_order, doc.pinned]);
    await c.query(
      'UPDATE document_versions SET document_id = $1 WHERE document_id = $2 AND language = $3',
      [newId, req.params.docId, lang]);
    await c.query(`UPDATE documents SET current_version_${lang} = $1 WHERE id = $2`,
      [doc[`${lang}_ver_id`], newId]);
    await c.query(
      `UPDATE documents SET current_version_${lang} = NULL, updated_at = now() WHERE id = $1`,
      [req.params.docId]);
    await refreshDocumentLanguage(c, req.params.docId);
    await refreshDocumentLanguage(c, newId);
    await bumpManifest(c);
  });

  const { rows } = await q(`${DOC_SELECT} WHERE d.id = $1`, [req.params.docId]);
  await audit(req, { action: 'document.unlink_language', entity: 'document',
    entityId: req.params.docId,
    summary: `${lang === 'en' ? 'Английската' : 'Българската'} версия на «${doc.title_bg}» `
      + 'беше отделена в самостоятелен документ',
    after: { newDocumentId: newId, language: lang } });
  res.json({ document: docOut(rows[0]), newDocumentId: newId });
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
    // Any version, current or historical, and either shown in the browser or saved to
    // disk — asking for an old copy should not mean restoring it first.
    const how = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `${how}; filename*=UTF-8''${encodeURIComponent(rows[0].filename)}`);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(storage.absPath(rows[0].stored_path));
  }));

module.exports = router;
