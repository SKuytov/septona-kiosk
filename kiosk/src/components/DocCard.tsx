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
  /*
    Whether there is anything to put on the right of the row at all.

    An empty element still holds its padding and its gap, so leaving it in place would keep
    a strip of the row reserved for chips that are not there. Rendered conditionally rather
    than hidden with :has(), which the panel's WebView cannot be relied on to support.
  */
  const showMeta =
    !row || doc.pinned || !cached || Boolean(showCategory && category);
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
        The row on the panel carries the title and nothing else.

        Language, page count, size and version number were all on the right of every row.
        None of them helps anyone choose a document: the language switch already filters the
        list, and nobody picks a policy because it is 3 pages or 246 KB. Twenty-one rows of
        them read as noise beside the one thing that identifies the document.

        Two marks survive, because they are warnings rather than facts about the file: the
        pin, and the sign that a document has no offline copy and so cannot be opened if the
        server is unreachable. Both are absent on a healthy panel.
      */}
      {showMeta ? (
      <div className="card__meta">
        {!row ? (
          <>
            <span className="chip chip--lang">
              {doc.language === 'both' ? 'BG · EN' : doc.language.toUpperCase()}
            </span>
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
          </>
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
      ) : null}

      {row && (
        <span className="card__go" aria-hidden="true">
          <Icon name="chevronRight" size={22} />
        </span>
      )}
    </button>
  );
}
