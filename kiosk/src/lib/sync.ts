/**
 * Sync engine.
 *
 * The kiosk is designed to run indefinitely with no network. Everything it renders
 * comes out of IndexedDB. Connectivity is only ever used to pull a newer manifest and
 * download PDFs that are new or revised. A failed sync is a non-event: the previously
 * cached content stays on screen.
 */
import type { Manifest, SyncState } from './types';
import { DEFAULT_SETTINGS } from './types';
import * as store from './store';

export const APP_VERSION = '1.0.8';

export interface Connection {
  baseUrl: string;
  deviceKey: string;
}

const CONN_KEY = 'connection';
const LAST_SYNC_KEY = 'lastSyncAt';

/**
 * Optional build-time provisioning. Setting VITE_DEFAULT_SERVER and
 * VITE_DEFAULT_DEVICE_KEY bakes a server address and device key into the APK, so a
 * display can be unboxed and powered on with no on-site configuration. A key saved
 * through the service screen always wins over the baked-in default.
 */
const BAKED: Connection | null = (() => {
  const baseUrl = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined)?.trim();
  const deviceKey = (import.meta.env.VITE_DEFAULT_DEVICE_KEY as string | undefined)?.trim();
  return baseUrl && deviceKey ? { baseUrl: baseUrl.replace(/\/+$/, ''), deviceKey } : null;
})();

/**
 * True when the app is being served over http(s) by the kiosk server itself — i.e. the
 * browser build at /kiosk — rather than running inside the APK, where Capacitor serves
 * the bundle from a local file/https://localhost origin and the server is remote.
 */
const isHostedWeb = (): boolean =>
  typeof window !== 'undefined' &&
  /^https?:$/.test(window.location.protocol) &&
  window.location.hostname !== 'localhost';

/**
 * The browser build is served by the same process that serves the API, so its server
 * address is simply its own origin. Only the device key has to be supplied, through the
 * service screen or a ?key= parameter.
 */
const sameOrigin = (): string => window.location.origin.replace(/\/+$/, '');

export async function getConnection(): Promise<Connection | undefined> {
  const saved = await store.metaGet<Connection>(CONN_KEY);
  if (saved?.baseUrl && saved?.deviceKey) return saved;
  if (BAKED) return BAKED;
  // A key can be handed to a browser kiosk by URL once: /kiosk/?key=sk_...
  if (isHostedWeb()) {
    const fromUrl = new URLSearchParams(window.location.search).get('key')?.trim();
    if (fromUrl) {
      const conn = { baseUrl: sameOrigin(), deviceKey: fromUrl };
      void setConnection(conn);
      // Drop the key from the address bar so it is not left in plain sight.
      window.history.replaceState({}, '', window.location.pathname);
      return conn;
    }
  }
  return undefined;
}

export const setConnection = (c: Connection) =>
  store.metaSet(CONN_KEY, { baseUrl: c.baseUrl.replace(/\/+$/, ''), deviceKey: c.deviceKey.trim() });

export const emptyState = (): SyncState => ({
  status: 'idle',
  progressDone: 0,
  progressTotal: 0,
  lastSyncAt: null,
  manifestVersion: null,
  cachedCount: 0,
  cachedBytes: 0,
});

async function request(conn: Connection, path: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    return await fetch(conn.baseUrl + path, {
      ...init,
      signal: ctrl.signal,
      headers: { ...(init?.headers || {}), 'X-Device-Key': conn.deviceKey },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Verify a server URL + device key pair before saving it. Used by the setup screen. */
export async function testConnection(conn: Connection): Promise<{ ok: boolean; message: string; documents?: number }> {
  try {
    const res = await request(conn, '/api/kiosk/manifest');
    if (res.status === 401) return { ok: false, message: 'Ключът на устройството е отхвърлен от сървъра.' };
    if (!res.ok) return { ok: false, message: `Сървърът отговори с код ${res.status}.` };
    const m = (await res.json()) as Manifest;
    return { ok: true, message: `Връзката е успешна — ${m.documents.length} документа.`, documents: m.documents.length };
  } catch (e) {
    return { ok: false, message: `Няма връзка със сървъра. ${(e as Error).message}` };
  }
}

export interface SyncResult {
  ok: boolean;
  message: string;
  manifest?: Manifest;
  downloaded: number;
  removed: number;
}

/**
 * Pull the manifest, then reconcile the local blob cache against it.
 * @param onProgress reports download progress so the UI can show a bar
 */
export async function sync(onProgress?: (s: Partial<SyncState>) => void): Promise<SyncResult> {
  const conn = await getConnection();
  if (!conn?.baseUrl || !conn?.deviceKey) {
    return { ok: false, message: 'Устройството не е настроено.', downloaded: 0, removed: 0 };
  }

  onProgress?.({ status: 'checking', message: 'Проверка за промени…' });

  let manifest: Manifest;
  try {
    const res = await request(conn, '/api/kiosk/manifest');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = (await res.json()) as Manifest;
    manifest.settings = { ...DEFAULT_SETTINGS, ...manifest.settings };
  } catch (e) {
    onProgress?.({ status: 'offline', message: 'Няма връзка — показва се запаметеното съдържание.' });
    return { ok: false, message: `Няма връзка със сървъра.`, downloaded: 0, removed: 0 };
  }

  // Save the manifest immediately: metadata is useful even if downloads fail midway.
  await store.saveManifest(manifest);

  const wanted = new Set(manifest.documents.map((d) => d.versionId));
  const present = new Set(await store.listFileIds());
  const missing = manifest.documents.filter((d) => !present.has(d.versionId));

  onProgress?.({
    status: missing.length ? 'downloading' : 'ok',
    progressDone: 0,
    progressTotal: missing.length,
    manifestVersion: manifest.manifestVersion,
    message: missing.length ? `Изтегляне на ${missing.length} документа…` : 'Съдържанието е актуално.',
  });

  let downloaded = 0;
  for (const doc of missing) {
    try {
      const res = await request(conn, doc.fileUrl);
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
      downloaded += 1;
    } catch {
      // Leave it uncached; the next sync retries. Other documents still succeed.
    }
    onProgress?.({
      progressDone: downloaded,
      progressTotal: missing.length,
      message: `Изтегляне ${downloaded}/${missing.length}…`,
    });
  }

  // Drop superseded versions so old revisions do not accumulate forever.
  let removed = 0;
  for (const versionId of present) {
    if (!wanted.has(versionId)) {
      await store.deleteFile(versionId);
      removed += 1;
    }
  }

  const stats = await store.cacheStats();
  const now = new Date().toISOString();
  await store.metaSet(LAST_SYNC_KEY, now);

  onProgress?.({
    status: 'ok',
    message:
      downloaded || removed
        ? `Обновено: +${downloaded} нови, −${removed} премахнати.`
        : 'Съдържанието е актуално.',
    progressDone: downloaded,
    progressTotal: missing.length,
    lastSyncAt: now,
    manifestVersion: manifest.manifestVersion,
    cachedCount: stats.count,
    cachedBytes: stats.bytes,
  });

  // Best effort — the panel uses this to show which displays are alive.
  request(conn, '/api/kiosk/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appVersion: APP_VERSION,
      manifestVersion: manifest.manifestVersion,
      docsCached: stats.count,
      storageBytes: stats.bytes,
    }),
  }).catch(() => undefined);

  return { ok: true, message: 'Синхронизацията завърши.', manifest, downloaded, removed };
}

export const getLastSync = () => store.metaGet<string>(LAST_SYNC_KEY);

/** Resolve a cached PDF to a blob URL for the viewer. Returns null when not cached. */
export async function pdfUrl(versionId: string): Promise<string | null> {
  const f = await store.getFile(versionId);
  if (!f) return null;
  return URL.createObjectURL(new Blob([f.bytes], { type: 'application/pdf' }));
}
