#!/usr/bin/env node
'use strict';
/*
 * Merge the separate Bulgarian and English records of the same policy into one document
 * holding two files.
 *
 * Before the two-slot model, a policy that existed in both languages had to be entered
 * twice, as two unrelated documents. This pairs those up: the English record's file becomes
 * the English slot of the Bulgarian record, and the English record is archived.
 *
 *   node scripts/merge-languages.js            # report only, changes nothing
 *   node scripts/merge-languages.js --apply    # perform the merges
 *
 * Pairing is deliberately conservative. Two records pair only when they sit in the same
 * category and their titles match closely once punctuation, case and the Bulgarian plural
 * endings are normalised away. Anything below the threshold is listed as a near miss for a
 * human to judge, never merged. Every merge is written to the audit log.
 */
const { q, tx, bumpManifest, refreshDocumentLanguage } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const THRESHOLD = 0.86;

/* Titles were typed by different people at different times: "Политика за безопасност на
 * продукт" against "Политика за безопасност на продуктите". Normalising case, punctuation
 * and the common Bulgarian article/plural endings makes those comparable. */
function normalise(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[«»"'`(),.\-–—:;/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w.replace(/(ите|ята|ата|ето|те|та|то|ът|я|и|а)$/u, ''))
    .join(' ');
}

/** Dice coefficient over character bigrams — forgiving of endings, strict about content. */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ga = grams(a); const gb = grams(b);
  let shared = 0; let total = 0;
  ga.forEach((n, g) => { total += n; shared += Math.min(n, gb.get(g) || 0); });
  gb.forEach((n) => { total += n; });
  return total ? (2 * shared) / total : 0;
}

/* The best evidence that two records are the same policy is any of their titles matching:
 * the English record often carries the Bulgarian title too, and vice versa. */
function score(bg, en) {
  const pairs = [
    [normalise(bg.title_bg), normalise(en.title_bg)],
    [normalise(bg.title_en), normalise(en.title_en)],
    [normalise(bg.title_en), normalise(en.title_bg)],
    [normalise(bg.title_bg), normalise(en.title_en)],
  ].filter(([a, b]) => a && b);
  return pairs.reduce((best, [a, b]) => Math.max(best, similarity(a, b)), 0);
}

async function main() {
  const { rows: docs } = await q(`
    SELECT d.id, d.category_id, d.title_bg, d.title_en, d.language,
           d.current_version_bg, d.current_version_en, c.name_bg AS category
    FROM documents d JOIN categories c ON c.id = d.category_id
    WHERE d.deleted_at IS NULL
    ORDER BY d.title_bg`);

  // Only records that hold exactly one language can be merged into a pair.
  const bgs = docs.filter((d) => d.current_version_bg && !d.current_version_en);
  const ens = docs.filter((d) => d.current_version_en && !d.current_version_bg);

  const candidates = [];
  bgs.forEach((bg) => ens.forEach((en) => {
    if (bg.category_id !== en.category_id) return;
    candidates.push({ bg, en, s: score(bg, en) });
  }));
  candidates.sort((a, b) => b.s - a.s);

  // Greedy, highest confidence first, so each record is claimed at most once.
  const takenBg = new Set(); const takenEn = new Set(); const merges = []; const nearMisses = [];
  candidates.forEach((c) => {
    if (takenBg.has(c.bg.id) || takenEn.has(c.en.id)) return;
    if (c.s >= THRESHOLD) {
      takenBg.add(c.bg.id); takenEn.add(c.en.id); merges.push(c);
    } else if (c.s >= 0.62) {
      nearMisses.push(c);
    }
  });

  console.log(`${docs.length} live documents: ${bgs.length} Bulgarian only, `
    + `${ens.length} English only.\n`);
  console.log(`WILL MERGE (${merges.length}):`);
  merges.forEach(({ bg, en, s }) => {
    console.log(`  ${s.toFixed(2)}  «${bg.title_bg}»`);
    console.log(`         + EN «${en.title_bg}» / «${en.title_en}»  [${bg.category}]`);
  });
  console.log(`\nNEAR MISSES — left alone, pair these by hand if they belong together `
    + `(${nearMisses.length}):`);
  nearMisses.forEach(({ bg, en, s }) => {
    console.log(`  ${s.toFixed(2)}  «${bg.title_bg}»  vs  «${en.title_bg}»  [${bg.category}]`);
  });
  const unpairedBg = bgs.filter((d) => !takenBg.has(d.id)).length;
  const unpairedEn = ens.filter((d) => !takenEn.has(d.id)).length;
  console.log(`\nLeft single: ${unpairedBg} Bulgarian, ${unpairedEn} English.`);

  if (!APPLY) {
    console.log('\nReport only. Re-run with --apply to perform the merges.');
    return;
  }

  for (const { bg, en, s } of merges) {
    // eslint-disable-next-line no-await-in-loop
    await tx(async (client) => {
      // Move the English record's versions across, renumbering them into their own chain.
      const { rows: vers } = await client.query(
        `SELECT id FROM document_versions WHERE document_id = $1 AND language = 'en'
         ORDER BY version_number`, [en.id]);
      let n = 0;
      for (const v of vers) {
        n += 1;
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `UPDATE document_versions SET document_id = $1, language = 'en', version_number = $2
           WHERE id = $3`, [bg.id, n, v.id]);
      }
      await client.query(
        `UPDATE documents SET current_version_en = $1,
           title_en = CASE WHEN title_en = '' THEN $2 ELSE title_en END
         WHERE id = $3`,
        [en.current_version_en, en.title_en || en.title_bg, bg.id]);
      await refreshDocumentLanguage(client, bg.id);

      // The English record is archived rather than deleted: its history stays reachable.
      await client.query(
        'UPDATE documents SET deleted_at = now(), current_version_en = NULL WHERE id = $1',
        [en.id]);

      await client.query(
        `INSERT INTO audit_log (actor_type, actor_name, action, entity, entity_id, summary,
           before, after)
         VALUES ('system', 'Сливане на езикови версии', 'document.merge_language',
                 'document', $1, $2, $3, $4)`,
        [bg.id,
          `Английската версия «${en.title_bg}» беше присъединена към «${bg.title_bg}»`,
          JSON.stringify({ mergedFrom: en.id, titleBg: en.title_bg, titleEn: en.title_en }),
          JSON.stringify({ documentId: bg.id, versionsMoved: vers.length,
            similarity: Number(s.toFixed(3)) })]);
    });
    console.log(`merged «${en.title_bg}» into «${bg.title_bg}»`);
  }
  if (merges.length) await bumpManifest();
  console.log(`\nDone. ${merges.length} merged.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
