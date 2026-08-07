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

/** Set once the bundle has been imported, so a deliberate cache wipe is not undone. */
const SEED_FLAG = 'seedImportedAt';

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
  // Never overwrite real content: a configured panel that has synced already has a
  // manifest, and that one is authoritative.
  if (await store.loadManifest()) return null;
  if (await store.metaGet<string>(SEED_FLAG)) return null;

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

  for (const doc of manifest.documents) {
    try {
      const res = await fetch(`./seed/${doc.versionId}.pdf`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      await store.putFile({
        versionId: doc.versionId,
        documentId: doc.id,
        bytes,
        sizeBytes: bytes.byteLength,
        sha256: doc.sha256,
        cachedAt: new Date().toISOString(),
      });
      embedded.push(doc);
    } catch {
      // Skip it rather than abort: 54 readable documents beat none. A later sync
      // against the server fills in whatever is missing.
    }
    done += 1;
    onProgress?.({ done, total });
  }

  if (!embedded.length) return null;

  // Describe only what actually made it into the store, so the board never shows a
  // card that cannot be opened.
  const imported: Manifest = { ...manifest, documents: embedded };
  await store.saveManifest(imported);
  await store.metaSet(SEED_FLAG, new Date().toISOString());
  return imported;
}
