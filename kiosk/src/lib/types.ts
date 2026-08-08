export type Lang = 'bg' | 'en';
export type DocLang = 'bg' | 'en' | 'both';

export interface KioskSettings {
  kioskTitle: string;
  defaultLanguage: Lang;
  /** Seconds without a touch before the panel puts itself back on the home screen. */
  homeAfterIdleSeconds: number;
  syncIntervalMinutes: number;
}

export interface Category {
  id: string;
  slug: string;
  nameBg: string;
  nameEn: string;
  icon: string;
  colour: string;
  sortOrder: number;
  visible: boolean;
  parentId: string | null;
}

/** One PDF: the Bulgarian or the English edition of a document. */
export interface DocFile {
  versionId: string;
  versionNumber: number;
  sha256: string;
  sizeBytes: number;
  pageCount: number | null;
  updatedAt: string;
  fileUrl: string;
}

export interface Doc {
  id: string;
  categoryId: string;
  titleBg: string;
  titleEn: string;
  language: DocLang;
  tags: string[];
  sortOrder: number;
  pinned: boolean;
  /* A document holds up to two PDFs, one per language; either may be missing. */
  files?: { bg: DocFile | null; en: DocFile | null };
  /* The flat fields below describe whichever file the server considers primary. They are
   * what a panel cached before the two-file model existed, so they are still read as a
   * fallback when a manifest saved by an older build is loaded from disk. */
  versionId: string;
  versionNumber: number;
  sha256: string;
  sizeBytes: number;
  pageCount: number | null;
  updatedAt: string;
  fileUrl: string;
}

export interface Manifest {
  manifestVersion: number;
  generatedAt: string;
  settings: KioskSettings;
  categories: Category[];
  documents: Doc[];
}

export interface SyncState {
  status: 'idle' | 'checking' | 'downloading' | 'ok' | 'offline' | 'error';
  message?: string;
  progressDone: number;
  progressTotal: number;
  lastSyncAt: string | null;
  manifestVersion: number | null;
  cachedCount: number;
  cachedBytes: number;
}

export const DEFAULT_SETTINGS: KioskSettings = {
  kioskTitle: 'СЕПТОНА — Документи',
  defaultLanguage: 'bg',
  homeAfterIdleSeconds: 60,
  syncIntervalMinutes: 15,
};

/** Title in the requested language, always falling back to whatever exists. */
export const docTitle = (d: Doc, lang: Lang): string =>
  (lang === 'en' ? d.titleEn || d.titleBg : d.titleBg || d.titleEn) || 'Без име';

export const catName = (c: Category, lang: Lang): string =>
  (lang === 'en' ? c.nameEn || c.nameBg : c.nameBg || c.nameEn) || '—';

/**
 * The PDF to show for this language, or null when the document has not been published in
 * it. Falls back to the flat fields for manifests cached by an older build.
 */
export const docFile = (d: Doc, lang: Lang): DocFile | null => {
  if (d.files) return d.files[lang] ?? null;
  return d.language === 'both' || d.language === lang
    ? { versionId: d.versionId, versionNumber: d.versionNumber, sha256: d.sha256,
        sizeBytes: d.sizeBytes, pageCount: d.pageCount, updatedAt: d.updatedAt,
        fileUrl: d.fileUrl }
    : null;
};

/** A document is listed only when there is something to open in the language on screen. */
export const matchesLang = (d: Doc, lang: Lang): boolean => docFile(d, lang) !== null;

/** Every file a document holds, for caching and for the storage figures. */
export const allFiles = (d: Doc): DocFile[] => (d.files
  ? [d.files.bg, d.files.en].filter((f): f is DocFile => !!f)
  : [{ versionId: d.versionId, versionNumber: d.versionNumber, sha256: d.sha256,
       sizeBytes: d.sizeBytes, pageCount: d.pageCount, updatedAt: d.updatedAt,
       fileUrl: d.fileUrl }]);
