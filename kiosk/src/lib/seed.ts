/**
 * First-run seed import.
 *
 * The APK can ship with the published document set embedded (see scripts/make-seed.mjs).
 * On the very first launch this copies that bundle into IndexedDB, so a panel that has
 * never been configured still shows the complete board — no server, no network.
 *
 * From then on it is ordinary cached content. The regular sync saves the server's
 * manifest and deletes any cached file the server does not reference, so pointing the
 * panel at a server replaces the seed instead of duplicating it, even when the server
 * has assigned different version ids to the same documents.
 */
import type { Manifest } from './types';
import { DEFAULT_SETTINGS } from './types';
import * as store from './store';
import { readBundledPdf } from './pdfBytes';
import { getLastSync } from './sync';

/** Set once the bundle has been imported, so a deliberate cache wipe is not undone. */
const SEED_FLAG = 'seedImportedAt';
/**
 * Which generation of the import logic produced the local copy.
 *
 * Bumped to 2 because generation 1 stored whatever bytes the asset read returned without
 * validating them, which could leave unopenable documents behind. A panel still holding
 * a generation-1 copy re-imports once, with validation, so those are replaced rather
 * than needing a manual cache wipe on site.
 */
const SEED_GEN_KEY = 'seedGeneration';
const SEED_GENERATION = 2;
/** Per-document rejection reasons from the last import, shown on the maintenance screen. */
export const SEED_DIAG = 'seedDiagnostics';

export interface SeedRejection {
  title: string;
  versionId: string;
  reason: string;
}

export interface SeedProgress {
  done: number;
  total: number;
}

/**
 * @returns the imported manifest, or null when there is nothing to do — no bundle in
 *          this build, content already present, or a previous import already ran.
 */
export async function importSeed(
  onProgress?: (p: SeedProgress) => void,
): Promise<Manifest | null> {
  // Never overwrite real content: once a panel has synced, the server is authoritative
  // and the bundled copy must not touch anything.
  if (await getLastSync()) return null;

  const generation = await store.metaGet<number>(SEED_GEN_KEY);
  const stale = generation !== SEED_GENERATION;

  // Up to date already? Then nothing to do — and a deliberate cache wipe stays wiped.
  if (!stale) {
    if (await store.loadManifest()) return null;
    if (await store.metaGet<string>(SEED_FLAG)) return null;
  }

  let manifest: Manifest;
  try {
    // Relative, because inside the APK the bundle is served from a file-like origin.
    const res = await fetch('./seed/manifest.json', { cache: 'no-store' });
    if (!res.ok) return null; // Build without a seed bundle — normal.
    manifest = (await res.json()) as Manifest;
  } catch {
    return null;
  }

  if (!manifest?.documents?.length) return null;
  manifest.settings = { ...DEFAULT_SETTINGS, ...manifest.settings };

  const total = manifest.documents.length;
  onProgress?.({ done: 0, total });

  let done = 0;
  const embedded: typeof manifest.documents = [];
  const rejected: SeedRejection[] = [];

  for (const doc of manifest.documents) {
    const label = doc.titleBg || doc.titleEn || doc.id;
    try {
      // Validated against the length the manifest recorded at build time, so a short
      // read is rejected here instead of surfacing later as an unopenable document.
      const read = await readBundledPdf(doc.versionId, doc.sizeBytes);
      if ('error' in read) throw new Error(read.error);
      await store.putFile({
        versionId: doc.versionId,
        documentId: doc.id,
        bytes: read.bytes,
        sizeBytes: read.bytes.byteLength,
        sha256: doc.sha256,
        cachedAt: new Date().toISOString(),
      });
      embedded.push(doc);
    } catch (e) {
      // Skip it rather than abort: readable documents beat none. A later sync against
      // the server fills in whatever is missing. The reason is kept for diagnosis.
      rejected.push({
        title: label,
        versionId: doc.versionId,
        reason: (e as Error)?.message?.slice(0, 180) || 'неизвестна грешка',
      });
    }
    done += 1;
    onProgress?.({ done, total });
  }

  await store.metaSet(SEED_DIAG, {
    at: new Date().toISOString(),
    total,
    imported: embedded.length,
    rejected,
  });

  if (!embedded.length) return null;

  // Describe only what actually made it into the store, so the board never shows a
  // card that cannot be opened.
  const imported: Manifest = { ...manifest, documents: embedded };
  await store.saveManifest(imported);
  await store.metaSet(SEED_FLAG, new Date().toISOString());
  await store.metaSet(SEED_GEN_KEY, SEED_GENERATION);
  return imported;
}
