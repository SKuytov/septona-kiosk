/**
 * The screen the panel shows when nobody is using it.
 *
 * It sits in the same pane the document list uses, so the header and the category buttons
 * stay exactly where they are and the panel does not appear to change shape when a category
 * is touched — only the pane underneath changes.
 *
 * It replaces the automatic category carousel, which cycled the list whether anyone was
 * reading it or not. Nothing here demands attention or moves quickly: two photographs
 * crossfading slowly, some drifting motes, and the mark in the middle. The point is that a
 * panel on a wall should look deliberate when it is idle rather than look like a computer
 * that has been left on.
 *
 * The images are bundled in the APK rather than fetched. The panel is expected to work with
 * no network at all, and a home screen that shows two broken images offline would be worse
 * than no home screen.
 */
import { useEffect, useMemo, useState } from 'react';
import { t } from '../lib/i18n';
import type { Lang } from '../lib/types';
/* Imported rather than referenced from `public/`: this way the bundler fingerprints them and
   guarantees they are in the APK, instead of relying on a path that resolves differently in
   the browser build and inside the WebView. */
import bg1 from '../assets/home-bg-1.jpg';
import bg2 from '../assets/home-bg-2.jpg';
import mark from '../assets/septona-mark.png';

/** How long each photograph is held before the next one fades in. */
const HOLD_MS = 25_000;
/** Motes. Enough to read as movement, few enough that a cheap panel keeps 60fps. */
const MOTES = 34;

const IMAGES = [bg1, bg2];

interface Props {
  lang: Lang;
  /** Shown under the mark, so the idle panel still says what it is for. */
  subtitle?: string;
}

export function HomeScreen({ lang, subtitle }: Props) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (IMAGES.length < 2) return;
    const timer = setInterval(() => setShown((i) => (i + 1) % IMAGES.length), HOLD_MS);
    return () => clearInterval(timer);
  }, []);

  /*
    The motes are given their positions and timings once and then left alone. Recomputing
    them on every render would restart every animation, and randomising them inside the
    render body would do the same on any unrelated state change — which is what made an
    earlier version of this flicker whenever the clock ticked.
  */
  const motes = useMemo(
    () =>
      Array.from({ length: MOTES }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        size: 3 + Math.random() * 7,
        duration: 16 + Math.random() * 20,
        delay: -Math.random() * 30,
        drift: (Math.random() - 0.5) * 90,
        opacity: 0.18 + Math.random() * 0.4,
      })),
    []
  );

  return (
    <div className="home" role="presentation">
      {IMAGES.map((src, i) => (
        <div
          key={src}
          className={`home__bg ${i === shown ? 'home__bg--on' : ''}`}
          style={{ backgroundImage: `url(${src})` }}
          aria-hidden="true"
        />
      ))}

      <div className="home__wash" aria-hidden="true" />

      <div className="home__motes" aria-hidden="true">
        {motes.map((m) => (
          <span
            key={m.id}
            className="home__mote"
            style={{
              left: `${m.left}%`,
              width: `${m.size}px`,
              height: `${m.size}px`,
              opacity: m.opacity,
              animationDuration: `${m.duration}s`,
              animationDelay: `${m.delay}s`,
              ['--drift' as string]: `${m.drift}px`,
            }}
          />
        ))}
      </div>

      <div className="home__centre">
        <img className="home__logo" src={mark} alt="Septona" draggable={false} />
        <div className="home__ttl">{subtitle || t(lang, 'homeTitle')}</div>
        <div className="home__hint">{t(lang, 'homeHint')}</div>
        <div className="home__cue" aria-hidden="true">
          <span className="home__arrow" />
          <span>{t(lang, 'homeAction')}</span>
        </div>
      </div>
    </div>
  );
}
