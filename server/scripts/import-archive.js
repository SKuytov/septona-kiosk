'use strict';
/**
 * One-off importer: turns a folder tree of documents into categories + documents.
 *
 *   node scripts/import-archive.js <path-to-extracted-folder>
 *
 * Top-level folders become categories. Nested folders whose name marks a language
 * (POLICIES_PDF_SIGNED_BG / _ENG) do NOT become subcategories — their documents are
 * tagged with that language instead, so the kiosk's global BG/EN switch filters them.
 * Legacy .docx/.xlsx/.ods files are converted to PDF via headless LibreOffice.
 */
const fs = require('fs');
const path = require('path');
const { q, tx, init, bumpManifest } = require('../src/db');
const { id, slugify, sha256, pdfPageCount, isPdf } = require('../src/util');
const storage = require('../src/storage');
const { audit } = require('../src/audit');

// Presentation defaults for the four folders shipped in KIOSK_DOCS.zip.
const CATEGORY_PRESETS = {
  'планове евакуация': { nameEn: 'Evacuation plans', icon: 'exit',       colour: '#C0392B', sortOrder: 10 },
  'политики':          { nameEn: 'Policies',         icon: 'policy',     colour: '#26307A', sortOrder: 20 },
  'постоянно видими':  { nameEn: 'Always visible',   icon: 'pin',        colour: '#2E8BC9', sortOrder: 30 },
  'основно упътване':  { nameEn: 'General guidance', icon: 'book',       colour: '#1F8A5B', sortOrder: 40 },
};

const LANG_FOLDER = [
  [/(^|_)(eng?|en)$/i, 'en'],
  [/(^|_)bg$/i, 'bg'],
];

function folderLanguage(name) {
  const upper = name.toUpperCase();
  if (/_ENG?$/.test(upper) || /\bENG\b/.test(upper)) return 'en';
  if (/_BG$/.test(upper) || /\bBG\b/.test(upper)) return 'bg';
  return null;
}

function fileLanguage(base) {
  const upper = base.toUpperCase();
  if (/[_\s-](ENG?|EN)$/.test(upper.trim())) return 'en';
  if (/[_\s-]BG$/.test(upper.trim())) return 'bg';
  if (/^[\u0400-\u04FF\s\W\d]*[\u0400-\u04FF]/.test(base)) return 'bg';
  return 'en';
}

/** «ПОЛИТИКА ЗА ЛИЧНАТА ХИГИЕНА_BG» → «Политика за личната хигиена» */
function prettyTitle(base) {
  let t = base
    .replace(/[_\s-]+(ENG?|EN|BG)\s*$/i, '')
    .replace(/_+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const letters = t.replace(/[^\p{L}]/gu, '');
  const uppers = [...letters].filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  if (letters.length > 3 && uppers / letters.length > 0.7) {
    t = t.toLowerCase().replace(/^\p{L}/u, (c) => c.toUpperCase());
  }
  return t.replace(/\s*_0*\d+$/, '').trim();
}

const OFFICE = new Set(['.docx', '.doc', '.xlsx', '.xls', '.ods', '.odt', '.pptx', '.ppt']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

async function ensureCategory(nameBg, sortFallback) {
  const preset = CATEGORY_PRESETS[nameBg.toLowerCase().trim()] || {};
  const { rows: found } = await q('SELECT * FROM categories WHERE lower(name_bg) = lower($1)', [nameBg]);
  if (found.length) return found[0].id;
  const catId = id('cat');
  let slug = slugify(nameBg);
  const { rows: clash } = await q('SELECT 1 FROM categories WHERE slug = $1', [slug]);
  if (clash.length) slug = `${slug}-${catId.slice(-4)}`;
  await q(
    `INSERT INTO categories (id,slug,name_bg,name_en,icon,colour,sort_order,visible)
     VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)`,
    [catId, slug, nameBg, preset.nameEn || '', preset.icon || 'doc',
     preset.colour || '#26307A', preset.sortOrder || sortFallback]);
  console.log(`  + category «${nameBg}»`);
  return catId;
}

async function main() {
  const root = process.argv[2];
  if (!root || !fs.existsSync(root)) {
    console.error('Usage: node scripts/import-archive.js <folder>');
    process.exit(1);
  }
  await init();

  const files = walk(root);
  console.log(`Found ${files.length} files under ${root}\n`);

  let imported = 0, skipped = 0, converted = 0, sortFallback = 50;

  for (const abs of files) {
    const rel = path.relative(root, abs);
    const parts = rel.split(path.sep);
    const topFolder = parts.length > 1 ? parts[0] : 'Други';
    const ext = path.extname(abs).toLowerCase();
    const base = path.basename(abs, path.extname(abs));

    if (ext !== '.pdf' && !OFFICE.has(ext)) { console.log(`  - skip ${rel} (unsupported)`); skipped++; continue; }

    // Language: an explicit language subfolder wins, otherwise infer from the filename.
    let language = null;
    for (const seg of parts.slice(1, -1)) { const l = folderLanguage(seg); if (l) language = l; }
    if (!language) language = fileLanguage(base);

    const categoryId = await ensureCategory(topFolder, (sortFallback += 10));

    let buffer = fs.readFileSync(abs);
    let wasConverted = false;
    if (!isPdf(buffer)) {
      try {
        process.stdout.write(`  ~ converting ${rel} … `);
        buffer = await storage.convertToPdf(buffer, path.basename(abs));
        wasConverted = true; converted++;
        console.log('ok');
      } catch (e) {
        console.log(`FAILED (${e.message})`); skipped++; continue;
      }
    }

    const hash = sha256(buffer);
    const { rows: dup } = await q('SELECT document_id FROM document_versions WHERE sha256 = $1 LIMIT 1', [hash]);
    if (dup.length) { console.log(`  = dup ${rel}`); skipped++; continue; }

    const stored = storage.store(buffer);
    const docId = id('doc');
    const versionId = id('ver');
    const title = prettyTitle(base);

    await tx(async (c) => {
      await c.query(
        `INSERT INTO documents (id,category_id,title_bg,title_en,language,tags,sort_order,current_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [docId, categoryId, title, language === 'en' ? title : '', language,
         [topFolder], (imported + 1) * 10, versionId]);
      await c.query(
        `INSERT INTO document_versions
         (id,document_id,version_number,filename,stored_path,sha256,size_bytes,page_count,note,source_filename,converted,uploaded_by_name)
         VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,'Импорт от архив')`,
        [versionId, docId, `${title}.pdf`, stored.storedPath, stored.hash, stored.sizeBytes,
         pdfPageCount(buffer), 'Първоначален импорт от KIOSK_DOCS.zip',
         wasConverted ? path.basename(abs) : null, wasConverted]);
    });
    console.log(`  + [${language}] ${title}`);
    imported++;
  }

  await bumpManifest();
  await audit(null, { action: 'document.create', entity: 'system',
    summary: `Импорт от архив: ${imported} документа, ${converted} преобразувани, ${skipped} пропуснати` });

  console.log(`\nDone. imported=${imported} converted=${converted} skipped=${skipped}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
