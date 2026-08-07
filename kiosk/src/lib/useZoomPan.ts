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
 * A horizontal drag also turns the page, and that has to share the one finger that pans a
 * zoomed page. The rule is the one every photo viewer uses: a sideways drag pans while the
 * page still has room to move in that direction, and only turns the page once it has run out
 * of room. At fit-width there is never any room, so a swipe always turns; zoomed in, the
 * swipe walks to the edge of the page first and a second swipe turns it. The choice is made
 * once, at the moment the drag declares a direction, and holds for the rest of that drag, so
 * a gesture can never change its mind halfway through.
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
/** A swipe must be this much more horizontal than vertical, or it is a scroll. */
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
  /** The page element, moved with the finger during a swipe. */
  pageRef: React.RefObject<HTMLElement | null>;
  /** A completed swipe: +1 for the next page, -1 for the previous one. */
  onSwipe: (dir: 1 | -1) => void;
  /** Whether a page exists in that direction. If not, the swipe rubber-bands back. */
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
  onSwipe,
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
  const mode = useRef<'pan' | 'swipe' | null>(null);
  const swipeDx = useRef(0);

  /** Moves the page sideways with the finger. Written straight to the node rather than
   *  through state: this runs on every pointer move and the panel's WebView is not fast
   *  enough to re-render React at that rate. */
  const dragPage = useCallback(
    (dx: number, settle: boolean) => {
      const el = pageRef.current;
      if (!el) return;
      el.style.transition = settle ? 'transform 180ms cubic-bezier(.2,.7,.3,1)' : 'none';
      el.style.transform = dx ? `translateX(${dx}px)` : '';
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
        const dir: 1 | -1 = dx < 0 ? 1 : -1;
        const maxScroll = stage.scrollWidth - stage.clientWidth;
        const room = dir === 1 ? start.left < maxScroll - 1 : start.left > 1;
        mode.current = horizontal && !room ? 'swipe' : 'pan';
      }

      if (mode.current === 'swipe') {
        // Beyond the first or last page the drag still follows the finger, but heavily
        // damped, so the panel answers the gesture instead of ignoring it.
        const dir: 1 | -1 = dx < 0 ? 1 : -1;
        swipeDx.current = canTurn(dir) ? dx : dx * RUBBER;
        dragPage(swipeDx.current, false);
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

      if (mode.current === 'swipe') {
        const dx = swipeDx.current;
        const dir: 1 | -1 = dx < 0 ? 1 : -1;
        const needed = Math.min(Math.max(stage.clientWidth * COMMIT_FRACTION, COMMIT_MIN), COMMIT_MAX);
        const flicked = Math.abs(velocity.current.x) > COMMIT_VELOCITY;
        const committed = canTurn(dir) && (Math.abs(dx) >= needed || flicked);
        mode.current = null;
        swipeDx.current = 0;
        dragPage(0, true);
        if (committed) onSwipe(dir);
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
    onSwipe,
    dragPage,
  ]);
}
