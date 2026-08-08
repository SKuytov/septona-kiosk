/**
 * Pinch-to-zoom, drag-to-pan and double-tap zoom for the document stage.
 *
 * The panel has no keyboard and no mouse, so the page has to be manipulated with fingers
 * the way any other document reader on a touch screen behaves.
 *
 * The stage sets `touch-action: none`, which is what makes a two-finger gesture deliver both
 * pointers to us instead of being consumed as a native scroll. The cost is that native
 * scrolling is gone, so panning is implemented here against the stage's own scroll offsets,
 * with a short glide after the finger leaves so a flick does not stop dead.
 *
 * Zoom is reported as a multiplier on whatever scale the caller is currently rendering, so
 * this hook never needs to know about fit modes or page geometry.
 *
 * A drag also turns the page, and that has to share the one finger that pans a zoomed page.
 * The rule is the one every photo viewer uses: a drag pans while the page still has room to
 * move in that direction, and only turns the page once it has run out of room. At fit-width
 * there is no sideways room, so a sideways swipe always turns; a downward drag scrolls to the
 * bottom of the page first and the next drag turns it. The choice is made once, at the moment
 * the drag declares a direction, and holds for the rest of that drag, so a gesture can never
 * change its mind halfway through.
 *
 * Both axes turn pages. Sideways is the obvious gesture on a panel held in portrait, but a
 * long document is read by dragging upwards, and having that stop dead at the end of a page
 * is the single most irritating thing a reader can do. So the same drag that scrolls the page
 * carries on into the next one.
 */
import { useCallback, useEffect, useRef } from 'react';

/** Movement under this is a tap, not a drag. */
const TAP_SLOP = 12;
/** Second tap must land inside this to count as a double-tap. */
const DOUBLE_TAP_MS = 320;
/** Below this velocity the glide is not worth starting. */
const MIN_FLICK = 0.05;
/** Per-frame velocity decay for the glide. */
const FRICTION = 0.94;
/** A drag stays undecided until it has travelled this far, so a tap is never a swipe. */
const DECIDE_SLOP = 10;
/** A swipe must be this much more one-directional than the other, or it is a pan. */
const H_DOMINANCE = 1.3;
/** Fraction of the stage width a swipe must cover to turn the page. */
const COMMIT_FRACTION = 0.22;
/** ...but never more than this, so the gesture stays easy on a wide panel. */
const COMMIT_MAX = 160;
/** ...and never less than this, so it cannot be triggered by a careless nudge. */
const COMMIT_MIN = 48;
/** A fast flick turns the page even if it did not travel the full distance. */
const COMMIT_VELOCITY = 0.45;
/** How far a swipe follows the finger when there is no page to turn to. */
const RUBBER = 0.25;

interface Options {
  /** The scrollable element wrapping the canvas. */
  stageRef: React.RefObject<HTMLElement | null>;
  /** The scale currently on screen, whatever fit mode produced it. */
  currentScale: () => number;
  /**
   * A finished zoom. `scale` is absolute; the caller clamps it and leaves its fit mode.
   * `u`/`v` are the point of the page the gesture was centred on, as a 0..1 fraction of the
   * page, and `x`/`y` are where on the screen that point should end up. The caller uses them
   * to keep what was under the fingers under the fingers, instead of jumping to the middle
   * of the page on every zoom.
   */
  onZoomCommit: (z: { scale: number; u: number; v: number; x: number; y: number }) => void;
  /** Double-tap, with the point tapped so the caller can zoom towards it. */
  onDoubleTap: (at: { u: number; v: number; x: number; y: number }) => void;
  /** Limits, so the live preview cannot be pinched past what the caller would allow. */
  minScale: number;
  maxScale: number;
  /** Any interaction, so the idle timer that resumes cycling is held off. */
  onActivity: () => void;
  /** The page element, moved with the finger when there is no page to turn to. */
  pageRef: React.RefObject<HTMLElement | null>;
  /**
   * Stages a page turn along `axis` towards `dir`. Returning false declines it, and the drag
   * falls back to dragging the page itself so the gesture is still answered.
   */
  onTurnStart: (axis: 'x' | 'y', dir: 1 | -1) => boolean;
  /** The finger, as signed pixels along the axis of the turn. */
  onTurnMove: (offset: number) => void;
  /** The finger left. `velocity` is px/ms along the axis, for the release animation. */
  onTurnEnd: (committed: boolean, velocity: number) => void;
  /** Whether a page exists in that direction. If not, the drag rubber-bands back. */
  canTurn: (dir: 1 | -1) => boolean;
  /** Disabled while the document is loading or has failed. */
  enabled: boolean;
}

export function useZoomPan({
  stageRef,
  pageRef,
  currentScale,
  onZoomCommit,
  onDoubleTap,
  minScale,
  maxScale,
  onActivity,
  canTurn,
  onTurnStart,
  onTurnMove,
  onTurnEnd,
  enabled,
}: Options): void {
  /** Live pointers by id, so a second finger is recognised as a pinch. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{
    dist: number;
    scale: number;
    /** The focal point as a fraction of the page, frozen when the second finger lands. */
    u: number;
    v: number;
    midX: number;
    midY: number;
    /** Where the fingers are now, so the page can be dragged while being pinched. */
    nowX: number;
    nowY: number;
    k: number;
  } | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const moved = useRef(0);
  const lastTap = useRef(0);
  const velocity = useRef({ x: 0, y: 0, at: 0 });
  const glide = useRef<number | null>(null);
  /** null while a drag has not yet declared itself one thing or the other. */
  const mode = useRef<'pan' | 'turn' | 'rubber' | null>(null);
  /** The axis a turn or rubber-band was committed to, frozen for the rest of the drag. */
  const turnAxis = useRef<'x' | 'y'>('x');
  /** The direction the staged turn is towards. Frozen too: dragging back cancels it rather
   *  than quietly turning the other way, which would need the other page staged. */
  const turnDir = useRef<1 | -1>(1);
  const swipeDx = useRef(0);

  /** Moves the page sideways with the finger. Written straight to the node rather than
   *  through state: this runs on every pointer move and the panel's WebView is not fast
   *  enough to re-render React at that rate. */
  const dragPage = useCallback(
    (d: number, settle: boolean) => {
      const el = pageRef.current;
      if (!el) return;
      el.style.transition = settle ? 'transform 180ms cubic-bezier(.2,.7,.3,1)' : 'none';
      if (!d) el.style.transform = '';
      else el.style.transform = turnAxis.current === 'x' ? `translateX(${d}px)` : `translateY(${d}px)`;
    },
    [pageRef]
  );

  const stopGlide = useCallback(() => {
    if (glide.current !== null) {
      cancelAnimationFrame(glide.current);
      glide.current = null;
    }
  }, []);

  /** A screen point expressed as a fraction of the page, for anchoring a zoom. */
  const onPage = useCallback(
    (x: number, y: number) => {
      const el = pageRef.current;
      const r = el?.getBoundingClientRect();
      if (!r || !r.width || !r.height) return { u: 0.5, v: 0.5 };
      return {
        u: Math.min(1, Math.max(0, (x - r.left) / r.width)),
        v: Math.min(1, Math.max(0, (y - r.top) / r.height)),
      };
    },
    [pageRef]
  );

  const midpoint = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return { x: 0, y: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !enabled) return;

    const onDown = (e: PointerEvent) => {
      stopGlide();
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      onActivity();

      if (pointers.current.size === 2) {
        /*
          Second finger down. The scale the pinch is measured against is frozen here, and so
          is the point of the page between the fingers: everything after this is previewed
          with a CSS transform about that point and only committed to a real render when the
          fingers lift. Re-rendering the PDF on every move meant pdf.js work at touch rate,
          which the panel's WebView cannot keep up with, so the pinch stuttered badly.
        */
        const mid = midpoint();
        const { u, v } = onPage(mid.x, mid.y);
        const el = pageRef.current;
        const r = el?.getBoundingClientRect();
        if (el && r) el.style.transformOrigin = `${u * r.width}px ${v * r.height}px`;
        pinch.current = {
          dist: spread(),
          scale: currentScale(),
          u,
          v,
          midX: mid.x,
          midY: mid.y,
          nowX: mid.x,
          nowY: mid.y,
          k: 1,
        };
        mode.current = null;
        swipeDx.current = 0;
        if (el) {
          el.style.transition = 'none';
          el.style.transform = '';
        }
        pan.current = null;
      } else if (pointers.current.size === 1) {
        moved.current = 0;
        mode.current = null;
        swipeDx.current = 0;
        velocity.current = { x: 0, y: 0, at: e.timeStamp };
        pan.current = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      const previous = pointers.current.get(e.pointerId)!;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // ---- pinch: preview with a transform, commit on release ----
      const p = pinch.current;
      if (pointers.current.size >= 2 && p) {
        const now = spread();
        const el = pageRef.current;
        if (p.dist > 0 && now > 0 && el) {
          // Clamp the preview to the same limits the caller enforces, so the page cannot be
          // stretched to a size that then snaps back when the fingers lift.
          const lo = minScale / p.scale;
          const hi = maxScale / p.scale;
          p.k = Math.min(hi, Math.max(lo, now / p.dist));
          const mid = midpoint();
          p.nowX = mid.x;
          p.nowY = mid.y;
          const dx = mid.x - p.midX;
          const dy = mid.y - p.midY;
          el.style.transition = 'none';
          el.style.transform = `translate(${dx}px, ${dy}px) scale(${p.k})`;
        }
        return;
      }

      // ---- pan or swipe ----
      const start = pan.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      moved.current = Math.max(moved.current, Math.hypot(dx, dy));

      /*
        Decide what this drag is, once, as soon as it has travelled far enough to have a
        direction. Dragging the page to the left asks for the next page, which is also the
        direction that scrolls the stage to the right; if the stage still has somewhere to
        scroll, the drag is panning a zoomed page and the page must not turn under it.
      */
      if (mode.current === null && moved.current >= DECIDE_SLOP) {
        const horizontal = Math.abs(dx) > Math.abs(dy) * H_DOMINANCE;
        const vertical = Math.abs(dy) > Math.abs(dx) * H_DOMINANCE;
        const axis: 'x' | 'y' | null = horizontal ? 'x' : vertical ? 'y' : null;
        const delta = axis === 'y' ? dy : dx;
        const dir: 1 | -1 = delta < 0 ? 1 : -1;
        // Dragging towards the next page is also the direction that scrolls the stage the
        // other way; if the stage still has somewhere to scroll, the page must not turn.
        const room =
          axis === 'y'
            ? dir === 1
              ? start.top < stage.scrollHeight - stage.clientHeight - 1
              : start.top > 1
            : dir === 1
              ? start.left < stage.scrollWidth - stage.clientWidth - 1
              : start.left > 1;

        if (axis && !room) {
          turnAxis.current = axis;
          turnDir.current = dir;
          // Beyond the first or last page there is nothing to stage, so the drag falls back
          // to dragging the page itself, damped — the panel answers rather than ignoring.
          mode.current = canTurn(dir) && onTurnStart(axis, dir) ? 'turn' : 'rubber';
        } else {
          mode.current = 'pan';
        }
      }

      if (mode.current === 'turn' || mode.current === 'rubber') {
        const raw = turnAxis.current === 'y' ? dy : dx;
        // Dragging back past where the gesture started unwinds the turn to nothing; it never
        // starts turning the other way, because the other page is not staged.
        const delta = turnDir.current === 1 ? Math.min(0, raw) : Math.max(0, raw);
        swipeDx.current = delta;
        if (mode.current === 'turn') onTurnMove(delta);
        else dragPage(delta * RUBBER, false);
        const dt0 = e.timeStamp - velocity.current.at;
        if (dt0 > 0) {
          velocity.current = {
            x: (e.clientX - previous.x) / dt0,
            y: (e.clientY - previous.y) / dt0,
            at: e.timeStamp,
          };
        }
        return;
      }

      stage.scrollLeft = start.left - dx;
      stage.scrollTop = start.top - dy;

      const dt = e.timeStamp - velocity.current.at;
      if (dt > 0) {
        velocity.current = {
          x: (e.clientX - previous.x) / dt,
          y: (e.clientY - previous.y) / dt,
          at: e.timeStamp,
        };
      }
    };

    const onUp = (e: PointerEvent) => {
      const wasSingle = pointers.current.size === 1;
      pointers.current.delete(e.pointerId);
      let finished: typeof pinch.current = null;
      if (pointers.current.size < 2) {
        finished = pinch.current;
        pinch.current = null;
      }

      if (!wasSingle) {
        // Coming out of a pinch: turn the previewed transform into a real render, asking for
        // the focal point to stay where the fingers left it.
        if (finished) {
          const el = pageRef.current;
          if (el) {
            el.style.transition = 'none';
            el.style.transform = '';
            el.style.transformOrigin = '';
          }
          if (Math.abs(finished.k - 1) > 0.005) {
            onZoomCommit({
              scale: finished.scale * finished.k,
              u: finished.u,
              v: finished.v,
              x: finished.nowX,
              y: finished.nowY,
            });
          }
        }
        // Rebase panning on whichever finger is still down.
        const rest = [...pointers.current.values()][0];
        pan.current = rest
          ? { x: rest.x, y: rest.y, left: stage.scrollLeft, top: stage.scrollTop }
          : null;
        return;
      }

      pan.current = null;

      if (mode.current === 'turn' || mode.current === 'rubber') {
        const wasTurn = mode.current === 'turn';
        const along = turnAxis.current;
        const dir = turnDir.current;
        const d = swipeDx.current;
        const extent = along === 'y' ? stage.clientHeight : stage.clientWidth;
        const needed = Math.min(Math.max(extent * COMMIT_FRACTION, COMMIT_MIN), COMMIT_MAX);
        const v = along === 'y' ? velocity.current.y : velocity.current.x;
        // A flick only counts towards the page it was thrown at. Without this a drag that is
        // dragged back and released still turns, because the speed is there but the sign is
        // the wrong way round.
        const flicked = Math.abs(v) > COMMIT_VELOCITY && (v < 0 ? 1 : -1) === dir;
        const committed = canTurn(dir) && (Math.abs(d) >= needed || flicked);
        mode.current = null;
        swipeDx.current = 0;
        if (wasTurn) onTurnEnd(committed, v);
        else dragPage(0, true);
        return;
      }

      mode.current = null;

      // A press that never travelled is a tap; two in quick succession toggle the zoom.
      if (moved.current < TAP_SLOP) {
        const now = e.timeStamp;
        if (now - lastTap.current < DOUBLE_TAP_MS) {
          lastTap.current = 0;
          const { u, v } = onPage(e.clientX, e.clientY);
          onDoubleTap({ u, v, x: e.clientX, y: e.clientY });
        } else {
          lastTap.current = now;
        }
        return;
      }

      // Otherwise let a flick glide to a stop.
      const v = velocity.current;
      if (Math.hypot(v.x, v.y) < MIN_FLICK) return;
      let vx = v.x;
      let vy = v.y;
      const step = () => {
        vx *= FRICTION;
        vy *= FRICTION;
        stage.scrollLeft -= vx * 16;
        stage.scrollTop -= vy * 16;
        glide.current = Math.hypot(vx, vy) > MIN_FLICK ? requestAnimationFrame(step) : null;
      };
      glide.current = requestAnimationFrame(step);
    };

    /** Ctrl+wheel is the desktop convention, for the browser version and for setup. */
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const { u, v } = onPage(e.clientX, e.clientY);
      onZoomCommit({
        scale: currentScale() * (e.deltaY < 0 ? 1.12 : 1 / 1.12),
        u,
        v,
        x: e.clientX,
        y: e.clientY,
      });
      onActivity();
    };

    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
      stage.removeEventListener('wheel', onWheel);
      stopGlide();
      pointers.current.clear();
      pinch.current = null;
      pan.current = null;
      mode.current = null;
      swipeDx.current = 0;
      dragPage(0, false);
      if (pageRef.current) pageRef.current.style.transformOrigin = '';
    };
  }, [
    stageRef,
    enabled,
    currentScale,
    onZoomCommit,
    onDoubleTap,
    onActivity,
    stopGlide,
    onPage,
    pageRef,
    minScale,
    maxScale,
    canTurn,
    onTurnStart,
    onTurnMove,
    onTurnEnd,
    dragPage,
  ]);
}
