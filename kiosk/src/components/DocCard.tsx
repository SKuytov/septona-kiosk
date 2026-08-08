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
   * Narrower card for the search overlay's results, where the full-width card would wrap
   * its title to five lines and push the list down to two visible entries.
   */
  compact?: boolean;
  /**
   * One full-width row per document instead of a tile in a grid.
   *
   * The grid of tiles fitted more documents on screen, and that was the wrong thing to
   * optimise: a policy is identified by its title and nothing else, and in a tile most of
   * these titles were clamped to three lines and truncated. A row gives the title the whole
   * width of the panel, which is what somebody standing in front of it is scanning.
   */
  row?: boolean;
  /** Marks the document currently open. */
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
  row,
  selected,
  onOpen,
}: Props) {
  const accent = category?.colour || 'var(--sep-blue)';
  return (
    <button
      className={[
        'card',
        row ? 'card--row' : '',
        compact ? 'card--compact' : '',
        selected ? 'card--on' : '',
      ]
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

      {/*
        In a row the details sit beside the title rather than under it, and the stylesheet
        drops them entirely on a narrow panel. They are still rendered so a screen reader and
        the browser version have them; what a document is called is the only thing that has
        to survive at every width.
      */}
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

      {row && (
        <span className="card__go" aria-hidden="true">
          <Icon name="chevronRight" size={22} />
        </span>
      )}
    </button>
  );
}
