/**
 * Subscribes to a CSS media query from React.
 *
 * The layout branches on available width rather than on a device guess: a phone stacks the
 * list and the document, while a tablet or the wall panel shows them side by side. Using the
 * same query the stylesheet uses keeps the two from disagreeing.
 */
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange(); // The query may already differ from the initial render.

    // `addEventListener` on MediaQueryList is Chrome 39+, but WebViews of that vintage exist
    // in the field and the deprecated `addListener` is all some of them have.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);

    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);

  return matches;
}

/**
 * Width at which the document opens beside the list instead of over it.
 *
 * 760px, not the 820px the rest of the stylesheet uses as its small-screen breakpoint. An
 * 11" Android tablet held in portrait is typically 1600x2560 physical at a device pixel
 * ratio of 2, which is 800 CSS px — just under 820, so it would have fallen back to the
 * phone layout on the very device this is going to be tested on. 760 covers it, and covers
 * the wall panel in portrait at 1080 CSS px, while a phone at 360-430px stays comfortably
 * below and keeps the full-screen reader that suits a narrow screen.
 *
 * At 760px the list takes its 286px minimum and the document still gets about 62% of the
 * width, which is the point at which a split stops being worth having.
 *
 * Declared here and mirrored by the `.main--split` classes App applies, so the component and
 * the stylesheet cannot disagree the way two copies of a media query would.
 */
export const SPLIT_QUERY = '(min-width: 760px)';
