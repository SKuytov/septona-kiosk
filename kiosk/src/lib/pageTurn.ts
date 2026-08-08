/**
 * The page turn.
 *
 * This is the gesture the whole panel is judged on, so it is worth writing down exactly what
 * it imitates. Pages behave like sheets on a clipboard:
 *
 *   - the NEXT page lies UNDERNEATH the one being read. Turning forwards slides the current
 *     sheet away and uncovers it.
 *   - the PREVIOUS page lies ON TOP. Turning backwards brings that sheet back down over the
 *     current one.
 *
 * So exactly one sheet ever moves, and which one it is depends on the direction. That single
 * rule is what makes the motion read as paper rather than as a slideshow, where both sides
 * slide together and nothing is ever occluded.
 *
 * Three details do most of the remaining work:
 *
 *   - the sheet underneath drifts at a fraction of the moving sheet's speed. Paper that is
 *     uncovered does shift a little, and a perfectly static layer underneath looks painted on.
 *   - the moving sheet carries a soft shadow, so it visibly floats above what it covers.
 *   - the sheet underneath starts in shade and brightens as it is revealed.
 *
 * Everything here is written straight to the DOM. This runs on every pointer move on a panel
 * whose WebView cannot re-render React at touch rate — the same reason the pinch preview in
 * `useZoomPan` is a CSS transform rather than a re-render.
 *
 * The sheets are flat snapshots of the stage, not live pages. That is what lets the turn work
 * identically whether the page is zoomed in, scrolled to the bottom, or sitting at fit-width:
 * what slides is exactly what the reader can see.
 */

export type Axis = 'x' | 'y';
/** +1 turns towards the next page, -1 towards the previous one. */
export type Dir = 1 | -1;

/** Fraction of the moving sheet's travel that the sheet underneath drifts. */
const PARALLAX = 0.12;
/** Darkness of the shade over a sheet that is still covered. */
const SHADE_MAX = 0.34;
/** Release animation bounds. Long enough to be seen, short enough never to be waited on. */
const MIN_MS = 170;
const MAX_MS = 340;

export interface PageTurnHost {
  /** The element the sheets are laid over. Must be positioned and clip its overflow. */
  container: HTMLElement;
  /** Paints what is on screen right now, at the given size in CSS pixels. */
  paintCurrent: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  /**
   * Paints the page being turned to, as it will look once it arrives — that is, at the top of
   * the page rather than at the current scroll offset, because arriving halfway down a page is
   * not how turning a page works. Returns false when that page has not finished rendering, in
   * which case the sheet is left blank and filled in by `refreshTarget` once it is ready.
   */
  paintTarget: (ctx: CanvasRenderingContext2D, w: number, h: number, dir: Dir) => boolean;
}

export interface PageTurn {
  /** Lays out the sheets and shows them. Returns false if the turn cannot be staged. */
  begin: (axis: Axis, dir: Dir) => boolean;
  /** Follows the finger. `offset` is signed pixels along the axis, as the finger has moved. */
  move: (offset: number) => void;
  /**
   * Finishes the gesture. Resolves once the sheet has stopped moving. After a committed turn
   * the sheets deliberately stay on screen, so the real page can be swapped in behind them
   * without a flash — call `finish` once that has happened. After a cancelled one they are
   * cleared automatically.
   */
  end: (committed: boolean, velocity: number) => Promise<void>;
  /** Repaints the target sheet, for when its page finished rendering mid-gesture. */
  refreshTarget: () => void;
  /** Clears the sheets. */
  finish: () => void;
  /** Whether a turn is currently staged. */
  active: () => boolean;
  /** Removes everything from the DOM. */
  destroy: () => void;
}

/** Sheets are sized in CSS pixels but drawn at device resolution, or they look soft. */
function sizeCanvas(
  c: HTMLCanvasElement,
  w: number,
  h: number,
  dpr: number
): CanvasRenderingContext2D | null {
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function createPageTurn(host: PageTurnHost): PageTurn {
  const root = document.createElement('div');
  root.className = 'turn';
  root.setAttribute('aria-hidden', 'true');

  /** The lower sheet. Never moves far; it is what the upper sheet covers or uncovers. */
  const under = document.createElement('div');
  under.className = 'turn__sheet turn__sheet--under';
  const underCanvas = document.createElement('canvas');
  const shade = document.createElement('div');
  shade.className = 'turn__shade';
  under.append(underCanvas, shade);

  /** The upper sheet. This is the one the finger drags, in both directions. */
  const over = document.createElement('div');
  over.className = 'turn__sheet turn__sheet--over';
  const overCanvas = document.createElement('canvas');
  over.append(overCanvas);

  root.append(under, over);
  host.container.appendChild(root);

  let axis: Axis = 'x';
  let dir: Dir = 1;
  let span = 1;
  let staged = false;
  let offsetNow = 0;
  /**
   * True when the page being turned to is the upper sheet — that is, when turning backwards.
   * Turning forwards the upper sheet is the page being read and the target is underneath.
   */
  let targetIsOver = false;

  const translate = (el: HTMLElement, px: number) => {
    el.style.transform = axis === 'x' ? `translate3d(${px}px,0,0)` : `translate3d(0,${px}px,0)`;
  };

  /** 0 at rest, 1 when the turn is complete. */
  const progressOf = (offset: number) => Math.min(1, Math.abs(offset) / span);

  /**
   * Both directions move the upper sheet along the same track, from one screen away to home:
   * forwards it starts at rest and leaves, backwards it starts off screen and arrives. Keeping
   * one track means the shading and the drift do not need to know which is happening.
   */
  const place = (offset: number) => {
    const travel = Math.min(span, Math.abs(offset));
    const p = travel / span;
    translate(over, targetIsOver ? -span + travel : -travel);
    // Forwards the lower sheet settles into place; backwards it is nudged aside.
    translate(under, PARALLAX * span * ((targetIsOver ? 0 : 1) - p) * -1);
    shade.style.opacity = String(SHADE_MAX * (1 - p));
    over.style.setProperty('--turn-lift', String(Math.min(1, p * 4)));
  };

  const begin = (a: Axis, d: Dir) => {
    const w = host.container.clientWidth;
    const h = host.container.clientHeight;
    if (w < 2 || h < 2) return false;

    axis = a;
    dir = d;
    span = axis === 'x' ? w : h;
    targetIsOver = dir === -1;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const overCtx = sizeCanvas(overCanvas, w, h, dpr);
    const underCtx = sizeCanvas(underCanvas, w, h, dpr);
    if (!overCtx || !underCtx) return false;

    if (targetIsOver) {
      host.paintTarget(overCtx, w, h, dir);
      host.paintCurrent(underCtx, w, h);
    } else {
      host.paintCurrent(overCtx, w, h);
      host.paintTarget(underCtx, w, h, dir);
    }

    root.classList.add('turn--on');
    // The live stage is hidden for the length of the turn; see `--turning` in app.css. The
    // class goes on the parent from here rather than being expressed as a CSS relationship,
    // because `:has()` is not something this panel's WebView can be relied on to support.
    root.parentElement?.classList.add('vw__stagewrap--turning');
    over.style.transition = 'none';
    under.style.transition = 'none';
    shade.style.transition = 'none';
    offsetNow = 0;
    place(0);
    // Force the starting position to be committed before any transition is attached, or the
    // browser may collapse the whole gesture into one animation from the previous state.
    void root.offsetHeight;
    staged = true;
    return true;
  };

  const move = (offset: number) => {
    if (!staged) return;
    offsetNow = offset;
    over.style.transition = 'none';
    under.style.transition = 'none';
    shade.style.transition = 'none';
    place(offset);
  };

  const end = (committed: boolean, velocity: number) => {
    if (!staged) return Promise.resolve();
    const p = progressOf(offsetNow);
    const remaining = committed ? 1 - p : p;
    // A flick should finish at roughly the speed it was thrown, a slow drag at a steady pace.
    const speed = Math.max(0.35, Math.min(4, Math.abs(velocity)));
    const ms = Math.min(MAX_MS, Math.max(MIN_MS, (remaining * span) / speed));
    const ease = committed ? 'cubic-bezier(.22,.61,.36,1)' : 'cubic-bezier(.33,1,.68,1)';

    return new Promise<void>((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        over.removeEventListener('transitionend', settle);
        if (!committed) {
          root.classList.remove('turn--on');
          root.parentElement?.classList.remove('vw__stagewrap--turning');
          staged = false;
        }
        resolve();
      };

      over.style.transition = `transform ${ms}ms ${ease}`;
      under.style.transition = `transform ${ms}ms ${ease}`;
      shade.style.transition = `opacity ${ms}ms linear`;
      over.addEventListener('transitionend', settle);

      place(committed ? span : 0);

      // A transition that never fires — interrupted, or zero length because the gesture was
      // already at its destination — must not leave the sheets stranded over the document.
      window.setTimeout(settle, ms + 90);
    });
  };

  const refreshTarget = () => {
    if (!staged) return;
    const w = host.container.clientWidth;
    const h = host.container.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ctx = sizeCanvas(targetIsOver ? overCanvas : underCanvas, w, h, dpr);
    if (ctx) host.paintTarget(ctx, w, h, dir);
  };

  const finish = () => {
    staged = false;
    root.classList.remove('turn--on');
    root.parentElement?.classList.remove('vw__stagewrap--turning');
    over.style.transition = 'none';
    under.style.transition = 'none';
    translate(over, 0);
    translate(under, 0);
  };

  return {
    begin,
    move,
    end,
    refreshTarget,
    finish,
    active: () => staged,
    destroy: () => {
      staged = false;
      // Belt and braces: whoever tears this down must not leave the document hidden behind
      // a layer that is no longer there.
      root.parentElement?.classList.remove('vw__stagewrap--turning');
      root.remove();
    },
  };
}
