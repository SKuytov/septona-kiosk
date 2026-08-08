import { t } from '../lib/i18n';
import type { Lang } from '../lib/types';
import { Icon } from './Icon';

/**
 * The keyboard drawn inside the app.
 *
 * A panel on a wall has no keys, and the Android keyboard cannot be relied on to appear:
 * under a locked launcher the input method is often suppressed, and where it does appear it
 * covers two thirds of a 1920px-tall screen and offers a layout nobody chose. Search would
 * then be a box that cannot be typed into — the one feature on the panel that is useless
 * without text.
 *
 * So the keys are part of the app. Cyrillic when the panel is in Bulgarian, Latin when it is
 * in English, with the other alphabet one key away, because document titles mix the two.
 */

const BG = [
  ['я', 'в', 'е', 'р', 'т', 'ъ', 'у', 'и', 'о', 'п', 'ш', 'щ'],
  ['а', 'с', 'д', 'ф', 'г', 'х', 'й', 'к', 'л', 'ч'],
  ['з', 'ь', 'ц', 'ж', 'б', 'н', 'м', 'ю'],
];

const EN = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export type KeysProps = {
  lang: Lang;
  /** Which alphabet is currently drawn — kept by the caller so it survives a re-render. */
  layout: 'bg' | 'en';
  onLayout: (next: 'bg' | 'en') => void;
  onKey: (character: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onClose: () => void;
};

export function Keys({ lang, layout, onLayout, onKey, onBackspace, onClear, onClose }: KeysProps) {
  const rows = layout === 'bg' ? BG : EN;

  return (
    <div className="kb" role="group" aria-label={t(lang, 'keyboard')}>
      <div className="kb__row kb__row--num">
        {DIGITS.map((d) => (
          <button key={d} className="kb__k kb__k--num" onClick={() => onKey(d)}>
            {d}
          </button>
        ))}
      </div>

      {rows.map((row, i) => (
        <div className="kb__row" key={i}>
          {i === rows.length - 1 && (
            <button
              className="kb__k kb__k--wide kb__k--alt"
              onClick={() => onLayout(layout === 'bg' ? 'en' : 'bg')}
              aria-label={t(lang, 'keyboardSwitch')}
            >
              {layout === 'bg' ? 'ABC' : 'АБВ'}
            </button>
          )}
          {row.map((c) => (
            <button key={c} className="kb__k" onClick={() => onKey(c)}>
              {c}
            </button>
          ))}
          {i === rows.length - 1 && (
            <button className="kb__k kb__k--wide" onClick={onBackspace} aria-label={t(lang, 'backspace')}>
              <Icon name="backspace" size={26} />
            </button>
          )}
        </div>
      ))}

      <div className="kb__row kb__row--last">
        <button className="kb__k kb__k--util" onClick={onClear}>
          {t(lang, 'clear')}
        </button>
        <button className="kb__k kb__k--space" onClick={() => onKey(' ')} aria-label={t(lang, 'space')}>
          <span className="kb__spaceline" />
        </button>
        <button className="kb__k kb__k--util kb__k--done" onClick={onClose}>
          {t(lang, 'done')}
        </button>
      </div>
    </div>
  );
}
