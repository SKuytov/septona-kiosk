/**
 * Build a seed bundle: the published document set, embedded in the APK.
 *
 * A freshly installed panel then shows the full board immediately, before anybody has
 * typed in a server address. Once it is pointed at a server, the normal sync takes
 * over: it saves the server's manifest and deletes every locally cached file the
 * server does not reference, so seeded content is replaced rather than duplicated.
 *
 * Usage — against a running management server:
 *
 *   SEED_SERVER=http://127.0.0.1:8080 \
 *   SEED_DEVICE_KEY=sk_xxx \
 *   node scripts/make-seed.mjs
 *
 * Writes kiosk/public/seed/. Pass --clean to remove the bundle instead, which
 * produces an APK that must be configured on site.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_DIR = fileURLToPath(new URL('../public/seed/', import.meta.url));

if (process.argv.includes('--clean')) {
  rmSync(SEED_DIR, { recursive: true, force: true });
  console.log('seed bundle removed');
  process.exit(0);
}

const SERVER = (process.env.SEED_SERVER || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const KEY = process.env.SEED_DEVICE_KEY;

if (!KEY) {
  console.error('SEED_DEVICE_KEY is required. Create a device in the admin panel to get one.');
  process.exit(1);
}

const headers = { 'X-Device-Key': KEY };

const manifestRes = await fetch(`${SERVER}/api/kiosk/manifest`, { headers });
if (!manifestRes.ok) {
  console.error(`Cannot read the manifest: HTTP ${manifestRes.status}`);
  console.error(manifestRes.status === 401 ? 'The device key was rejected.' : `Is ${SERVER} running?`);
  process.exit(1);
}
const manifest = await manifestRes.json();

rmSync(SEED_DIR, { recursive: true, force: true });
mkdirSync(SEED_DIR, { recursive: true });

console.log(`seeding from ${SERVER}`);
console.log(`  manifest v${manifest.manifestVersion} · ${manifest.categories.length} categories · ${manifest.documents.length} documents`);

let bytes = 0;
let failed = 0;
const kept = [];

for (const doc of manifest.documents) {
  const label = (doc.titleBg || doc.titleEn || doc.id).slice(0, 46);
  try {
    const res = await fetch(SERVER + doc.fileUrl, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    // A truncated or wrong-typed file would fail silently on the panel, long after
    // anybody could connect it to this build step. Check it here instead.
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('not a PDF (bad magic bytes)');
    }
    if (doc.sizeBytes && buf.length !== doc.sizeBytes) {
      throw new Error(`size mismatch: manifest ${doc.sizeBytes}, got ${buf.length}`);
    }

    writeFileSync(join(SEED_DIR, `${doc.versionId}.pdf`), buf);
    bytes += buf.length;
    kept.push(doc);
  } catch (e) {
    // Ship the bundle without this document rather than embedding a broken file.
    console.warn(`  !! skipped ${label}: ${e.message}`);
    failed += 1;
  }
}

// The bundled manifest must describe only what was actually embedded, otherwise the
// panel shows cards for documents it cannot open.
const seedManifest = {
  ...manifest,
  documents: kept,
  seededAt: new Date().toISOString(),
  seedSource: SERVER,
};

writeFileSync(join(SEED_DIR, 'manifest.json'), JSON.stringify(seedManifest));

console.log(`  embedded ${kept.length} documents, ${(bytes / 1e6).toFixed(1)} MB`);
if (failed) console.log(`  ${failed} skipped`);
console.log(`  -> ${SEED_DIR}`);

if (!kept.length) {
  console.error('Nothing was embedded; refusing to write an empty seed.');
  rmSync(SEED_DIR, { recursive: true, force: true });
  process.exit(1);
}

if (!existsSync(join(SEED_DIR, 'manifest.json'))) process.exit(1);
