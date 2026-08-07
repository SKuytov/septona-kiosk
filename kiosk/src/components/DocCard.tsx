import { Icon } from './Icon';
import { t, formatBytes } from '../lib/i18n';
import { docTitle } from '../lib/types';
import type { Category, Doc, Lang } from '../lib/types';

interface Props {
  doc: Doc;
  lang: Lang;
  category?: Category;
  cached: boolean;
  highlight?: string;
  showCategory?: boolean;
  /**
   * Narrower card for the split layout's left column, where the full-width card would wrap
   * its title to five lines and push the list down to two visible entries.
   */
  compact?: boolean;
  /** Marks the document currently open in the pane beside the list. */
  selected?: boolean;
  onOpen: (d: Doc) => void;
}

/** Wraps matched search text in <mark> without using dangerouslySetInnerHTML. */
function Highlighted({ text, needle }: { text: string; needle?: string }) {
  if (!needle || needle.trim().length < 2) return <>{text}</>;
  const idx = text.toLocaleLowerCase().indexOf(needle.trim().toLocaleLowerCase());
  if (idx < 0) return <>{text}</>;
  const end = idx + needle.trim().length;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, end)}</mark>
      {text.slice(end)}
    </>
  );
}

export function DocCard({
  doc,
  lang,
  category,
  cached,
  highlight,
  showCategory,
  compact,
  selected,
  onOpen,
}: Props) {
  const accent = category?.colour || 'var(--sep-blue)';
  return (
    <button
      className={['card', compact ? 'card--compact' : '', selected ? 'card--on' : '']
        .filter(Boolean)
        .join(' ')}
      style={{ ['--card-accent' as string]: accent }}
      // Lets a screen reader, and the styling, express which document is being read.
      aria-current={selected ? 'true' : undefined}
      onClick={() => onOpen(doc)}
    >
      <div className="card__top">
        <span className="card__ic" aria-hidden="true">
          <Icon name={category?.icon || 'doc'} size={compact ? 20 : 24} />
        </span>
        <span className="card__t">
          <Highlighted text={docTitle(doc, lang)} needle={highlight} />
        </span>
      </div>

      <div className="card__meta">
        <span className="chip chip--lang">{doc.language === 'both' ? 'BG · EN' : doc.language.toUpperCase()}</span>
        {doc.pageCount ? (
          <span className="chip">
            {doc.pageCount} {t(lang, 'pages')}
          </span>
        ) : null}
        <span className="chip">{formatBytes(doc.sizeBytes)}</span>
        {doc.versionNumber > 1 ? (
          <span className="chip">
            {t(lang, 'version')} {doc.versionNumber}
          </span>
        ) : null}
        {doc.pinned ? (
          <span className="chip chip--pin">
            <Icon name="pin" size={13} />
          </span>
        ) : null}
        {showCategory && category ? (
          <span className="chip chip--cat">{lang === 'en' ? category.nameEn || category.nameBg : category.nameBg}</span>
        ) : null}
        {!cached ? (
          <span className="chip chip--off">
            <Icon name="wifiOff" size={13} />
          </span>
        ) : null}
      </div>
    </button>
  );
}
