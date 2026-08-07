import type { Lang } from './types';

const STRINGS = {
  bg: {
    allCategories: 'Всички категории',
    search: 'Търсене',
    searchPlaceholder: 'Търсене на документ…',
    searchHint: 'Въведете дума от заглавието на документа',
    noResults: 'Няма намерени документи',
    noResultsHint: 'Опитайте с друга дума или сменете езика',
    documents: 'документа',
    document: 'документ',
    emptyCategory: 'В тази категория няма документи на избрания език',
    back: 'Назад',
    close: 'Затвори',
    page: 'Стр.',
    of: 'от',
    version: 'Версия',
    updated: 'Обновен',
    pages: 'стр.',
    loading: 'Зареждане…',
    notCached: 'Документът още не е изтеглен',
    notCachedHint: 'Свържете устройството с мрежата и изчакайте синхронизация',
    openFailed: 'Документът не може да бъде отворен',
    autoCycle: 'Автоматично превъртане',
    paused: 'На пауза',
    resumingIn: 'Продължава след',
    seconds: 'с',
    tapToPause: 'Докоснете за пауза',
    offline: 'Офлайн режим',
    synced: 'Актуално',
    syncing: 'Синхронизация…',
    notConfigured: 'Не е настроено',
    setup: 'Настройка на устройството',
    serverUrl: 'Адрес на сървъра',
    deviceKey: 'Ключ на устройството',
    testConnection: 'Провери връзката',
    save: 'Запази',
    syncNow: 'Синхронизирай сега',
    storage: 'Локална памет',
    cached: 'запаметени документа',
    lastSync: 'Последна синхронизация',
    never: 'никога',
    clearCache: 'Изчисти локалната памет',
    clearCacheConfirm: 'Наистина ли да изтрия всички запаметени документи? Ще бъдат изтеглени отново при следваща синхронизация.',
    enterPin: 'Въведете сервизен код',
    wrongPin: 'Грешен код',
    exit: 'Изход',
    appVersion: 'Версия на приложението',
    manifestVersion: 'Версия на съдържанието',
    noContent: 'Няма заредено съдържание',
    noContentHint: 'Задръжте логото 3 секунди, за да настроите устройството',
    zoomIn: 'Увеличи',
    zoomOut: 'Намали',
    fitPage: 'Цяла страница',
    fitWidth: 'По ширина',
    prevPage: 'Предишна',
    nextPage: 'Следваща',
  },
  en: {
    allCategories: 'All categories',
    search: 'Search',
    searchPlaceholder: 'Search for a document…',
    searchHint: 'Type a word from the document title',
    noResults: 'No documents found',
    noResultsHint: 'Try another word or switch the language',
    documents: 'documents',
    document: 'document',
    emptyCategory: 'No documents in this category for the selected language',
    back: 'Back',
    close: 'Close',
    page: 'Page',
    of: 'of',
    version: 'Version',
    updated: 'Updated',
    pages: 'pp.',
    loading: 'Loading…',
    notCached: 'This document has not been downloaded yet',
    notCachedHint: 'Connect the display to the network and wait for a sync',
    openFailed: 'The document could not be opened',
    autoCycle: 'Auto-cycling',
    paused: 'Paused',
    resumingIn: 'Resumes in',
    seconds: 's',
    tapToPause: 'Touch to pause',
    offline: 'Offline mode',
    synced: 'Up to date',
    syncing: 'Syncing…',
    notConfigured: 'Not configured',
    setup: 'Device setup',
    serverUrl: 'Server address',
    deviceKey: 'Device key',
    testConnection: 'Test connection',
    save: 'Save',
    syncNow: 'Sync now',
    storage: 'Local storage',
    cached: 'cached documents',
    lastSync: 'Last sync',
    never: 'never',
    clearCache: 'Clear local storage',
    clearCacheConfirm: 'Delete all cached documents? They will be downloaded again on the next sync.',
    enterPin: 'Enter service code',
    wrongPin: 'Wrong code',
    exit: 'Exit',
    appVersion: 'App version',
    manifestVersion: 'Content version',
    noContent: 'No content loaded',
    noContentHint: 'Press and hold the logo for 3 seconds to set up the device',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fitPage: 'Fit page',
    fitWidth: 'Fit width',
    prevPage: 'Previous',
    nextPage: 'Next',
  },
} as const;

export type StringKey = keyof (typeof STRINGS)['bg'];

export const t = (lang: Lang, key: StringKey): string => STRINGS[lang][key];

export const plural = (lang: Lang, n: number): string =>
  n === 1 ? t(lang, 'document') : t(lang, 'documents');

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(iso: string | null, lang: Lang): string {
  if (!iso) return t(lang, 'never');
  try {
    return new Date(iso).toLocaleString(lang === 'bg' ? 'bg-BG' : 'en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
