import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { DocCard } from './DocCard';
import { t, plural } from '../lib/i18n';
import { docTitle, matchesLang } from '../lib/types';
import type { Category, Doc, Lang } from '../lib/types';

interface Props {
  docs: Doc[];
  categories: Category[];
  lang: Lang;
  cachedIds: Set<string>;
  onOpen: (d: Doc) => void;
  onClose: () => void;
  onActivity: () => void;
}

/** Fold Cyrillic and Latin diacritics so search is forgiving of case and accents. */
const norm = (s: string) =>
  s.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

export function SearchOverlay({
  docs, categories, lang, cachedIds, onOpen, onClose, onActivity,
}: Props) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const results = useMemo(() => {
    const needle = norm(query);
    if (needle.length < 2) return [];
    const terms = needle.split(/\s+/).filter(Boolean);

    return docs
      .filter((d) => matchesLang(d, lang))
      .map((d) => {
        const title = norm(docTitle(d, lang));
        const alt = norm(`${d.titleBg} ${d.titleEn}`);
        const cat = catById.get(d.categoryId);
        const haystack = `${alt} ${norm(d.tags.join(' '))} ${norm(cat ? `${cat.nameBg} ${cat.nameEn}` : '')}`;

        // Every term must appear somewhere; rank title-prefix hits highest.
        if (!terms.every((term) => haystack.includes(term))) return null;
        let score = 0;
        for (const term of terms) {
          if (title.startsWith(term)) score += 100;
          else if (title.includes(term)) score += 50;
          else score += 10;
        }
        if (d.pinned) score += 5;
        return { doc: d, score };
      })
      .filter((x): x is { doc: Doc; score: number } => x !== null)
      .sort((a, b) => b.score - a.score || docTitle(a.doc, lang).localeCompare(docTitle(b.doc, lang), lang))
      .slice(0, 60)
      .map((x) => x.doc);
  }, [query, docs, lang, catById]);

  const showEmpty = query.trim().length >= 2 && results.length === 0;
  const showHint = query.trim().length < 2;

  return (
    <div className="ovl" onPointerDown={onActivity}>
      <div className="srch">
        <div className="srch__wrap">
          <span className="srch__ic">
            <Icon name="searchGlass" size={24} />
          </span>
          <input
            ref={inputRef}
            className="srch__in"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              onActivity();
            }}
            placeholder={t(lang, 'searchPlaceholder')}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="search"
          />
        </div>
        <button className="srch__x" onClick={onClose} aria-label={t(lang, 'close')}>
          <Icon name="x" size={26} />
        </button>
      </div>

      <div className="srch__body">
        {showHint ? (
          <div className="empty">
            <span className="empty__ic" style={{ background: 'rgba(255,255,255,.14)', color: '#fff' }}>
              <Icon name="searchGlass" size={44} />
            </span>
            <div className="empty__t" style={{ color: '#fff' }}>{t(lang, 'search')}</div>
            <div className="empty__s" style={{ color: 'rgba(255,255,255,.76)' }}>{t(lang, 'searchHint')}</div>
          </div>
        ) : showEmpty ? (
          <div className="empty">
            <span className="empty__ic" style={{ background: 'rgba(255,255,255,.14)', color: '#fff' }}>
              <Icon name="searchGlass" size={44} />
            </span>
            <div className="empty__t" style={{ color: '#fff' }}>{t(lang, 'noResults')}</div>
            <div className="empty__s" style={{ color: 'rgba(255,255,255,.76)' }}>{t(lang, 'noResultsHint')}</div>
          </div>
        ) : (
          <>
            <div className="srch__n">
              {results.length} {plural(lang, results.length)}
            </div>
            <div className="grid">
              {results.map((d) => (
                <DocCard
                  key={d.id}
                  doc={d}
                  lang={lang}
                  category={catById.get(d.categoryId)}
                  cached={cachedIds.has(d.versionId)}
                  highlight={query}
                  showCategory
                  onOpen={onOpen}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
