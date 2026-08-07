/**
 * Offline persistence for the kiosk.
 *
 * IndexedDB is used for both the manifest and the PDF blobs. It works identically in
 * the Android WebView (inside the APK) and in a desktop browser, survives reboots and
 * app upgrades, and needs no native plugin. PDF bytes are keyed on versionId, which is
 * immutable server-side — so a cached entry is never stale, only superseded.
 */
import type { Manifest } from './types';

const DB_NAME = 'septona-kiosk';
const DB_VERSION = 1;
const STORE_META = 'meta';
const STORE_FILES = 'files';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

// ---- meta (manifest, sync bookkeeping, local preferences) -------------------

export const metaGet = <T>(key: string): Promise<T | undefined> =>
  tx<T>(STORE_META, 'readonly', (s) => s.get(key) as IDBRequest<T>);

export const metaSet = (key: string, value: unknown): Promise<unknown> =>
  tx(STORE_META, 'readwrite', (s) => s.put(value as any, key) as IDBRequest<any>);

export const saveManifest = (m: Manifest) => metaSet('manifest', m);
export const loadManifest = () => metaGet<Manifest>('manifest');

// ---- PDF blobs -------------------------------------------------------------

export interface CachedFile {
  versionId: string;
  documentId: string;
  bytes: ArrayBuffer;
  sizeBytes: number;
  sha256: string;
  cachedAt: string;
}

export const putFile = (f: CachedFile) =>
  tx(STORE_FILES, 'readwrite', (s) => s.put(f, f.versionId) as IDBRequest<any>);

export const getFile = (versionId: string) =>
  tx<CachedFile | undefined>(STORE_FILES, 'readonly', (s) => s.get(versionId) as IDBRequest<CachedFile | undefined>);

export const hasFile = (versionId: string) =>
  tx<number>(STORE_FILES, 'readonly', (s) => s.count(versionId)).then((n) => n > 0);

export const deleteFile = (versionId: string) =>
  tx(STORE_FILES, 'readwrite', (s) => s.delete(versionId) as IDBRequest<any>);

export const listFileIds = () =>
  tx<IDBValidKey[]>(STORE_FILES, 'readonly', (s) => s.getAllKeys()).then((k) => k.map(String));

/** Total bytes held locally — surfaced in the maintenance screen and heartbeat. */
export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_FILES, 'readonly');
    const cursorReq = t.objectStore(STORE_FILES).openCursor();
    let count = 0;
    let bytes = 0;
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (cur) {
        const v = cur.value as CachedFile;
        count += 1;
        bytes += v.sizeBytes || v.bytes?.byteLength || 0;
        cur.continue();
      } else {
        resolve({ count, bytes });
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export async function clearFiles(): Promise<void> {
  await tx(STORE_FILES, 'readwrite', (s) => s.clear() as IDBRequest<any>);
}

/** Ask the browser to keep our data even under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* not supported */
  }
  return false;
}
