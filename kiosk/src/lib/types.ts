export type Lang = 'bg' | 'en';
export type DocLang = 'bg' | 'en' | 'both';

export interface KioskSettings {
  cycleEnabled: boolean;
  cycleSeconds: number;
  idleResumeSeconds: number;
  defaultLanguage: Lang;
  kioskTitle: string;
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
  cycleSeconds: number | null;
  visible: boolean;
  parentId: string | null;
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
  cycleEnabled: true,
  cycleSeconds: 45,
  idleResumeSeconds: 90,
  defaultLanguage: 'bg',
  kioskTitle: 'СЕПТОНА — Документи',
  syncIntervalMinutes: 15,
};

/** Title in the requested language, always falling back to whatever exists. */
export const docTitle = (d: Doc, lang: Lang): string =>
  (lang === 'en' ? d.titleEn || d.titleBg : d.titleBg || d.titleEn) || 'Без име';

export const catName = (c: Category, lang: Lang): string =>
  (lang === 'en' ? c.nameEn || c.nameBg : c.nameBg || c.nameEn) || '—';

/** A document is shown when it matches the active language or is marked for both. */
export const matchesLang = (d: Doc, lang: Lang): boolean =>
  d.language === 'both' || d.language === lang;
