/**
 * The hidden gesture that opens the maintenance screen: press and hold the logo.
 *
 * ## Why this is not just a pointer-event timer
 *
 * The first implementation used `onPointerDown` on the logo image with `onPointerUp`,
 * `onPointerLeave` and `onPointerCancel` all cancelling the timer. On a desktop mouse that
 * works. On an Android touch screen it never fired, which is exactly what was reported from
 * the panel: holding the logo did nothing at all.
 *
 * Two things go wrong there. Android WebView starts its own long-press handling over an
 * `<img>` — the selection callout and image drag — and when it does, it takes over the
 * gesture and fires `pointercancel`, silently clearing the timer at roughly the moment the
 * hold becomes interesting. The image is also a drag source in its own right, which can end
 * the pointer stream early.
 *
 * So this hook binds `touchstart` itself, on a wrapper element rather than on the image, and
 * keeps mouse events for setup with a keyboard and mouse.
 *
 * It binds them as **native, non-passive** listeners through a ref rather than as React
 * `onTouchStart` props. React registers `touchstart` and `touchmove` at the root as passive,
 * so `preventDefault()` inside a React touch handler is ignored and logs "Unable to
 * preventDefault inside passive event listener invocation" — meaning the native long-press
 * behaviour this needs to suppress would go ahead anyway. The browser test caught exactly
 * that. CSS covers most of it, but the listener has to be able to say no as well.
 *
 * ## Two ways in
 *
 * A hidden gesture that fails silently is expensive: the panel is on a wall and the person
 * in front of it has no way to tell a wrong gesture from a broken build. So there are two
 * paths, and the caller renders a progress ring so the hold is visibly doing something:
 *
 *   - hold for `holdMs`, cancelled if the finger travels more than `MOVE_TOLERANCE`;
 *   - or `TAP_COUNT` deliberate taps inside `TAP_WINDOW_MS`, which needs no timing at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Finger travel that means the gesture was a scroll or a slip, not a hold. */
const MOVE_TOLERANCE = 20;
/** Taps needed for the alternative route in. */
const TAP_COUNT = 5;
/**
 * Window the taps must all fall inside. Deliberately generous: this is a wall panel, the
 * person tapping it is often wearing gloves, and a fallback that demands machine-gun timing
 * is no fallback at all.
 */
const TAP_WINDOW_MS = 4000;
/** Progress is hidden below this, so an ordinary tap shows no stray feedback. */
const FEEDBACK_AFTER_MS = 450;

export interface HoldGesture {
  /** Attach to the element that should receive the gesture. */
  ref: (el: HTMLElement | null) => void;
  /** 0 to 1 once the hold has run past the feedback threshold, else 0. */
  progress: number;
}

export function useHoldGesture(onTrigger: () => void, holdMs = 3000): HoldGesture {
  const timer = useRef<number | null>(null);
  const ticker = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const taps = useRef<number[]>([]);
  const [progress, setProgress] = useState(0);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (ticker.current !== null) {
      clearInterval(ticker.current);
      ticker.current = null;
    }
    setProgress(0);
  }, []);

  const begin = useCallback(
    (x: number, y: number) => {
      stop();
      origin.current = { x, y };
      const startedAt = Date.now();

      timer.current = window.setTimeout(() => {
        timer.current = null;
        origin.current = null;
        stop();
        onTrigger();
      }, holdMs);

      ticker.current = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        setProgress(elapsed < FEEDBACK_AFTER_MS ? 0 : Math.min(1, elapsed / holdMs));
      }, 60);
    },
    [holdMs, onTrigger, stop]
  );

  /** Travelling too far means this was a scroll: give up without counting a tap. */
  const move = useCallback(
    (x: number, y: number) => {
      const from = origin.current;
      if (!from) return;
      if (Math.abs(x - from.x) > MOVE_TOLERANCE || Math.abs(y - from.y) > MOVE_TOLERANCE) {
        origin.current = null;
        stop();
      }
    },
    [stop]
  );

  const end = useCallback(() => {
    // Only a hold still pending counts as a tap. If the timer already fired we are on the
    // maintenance screen, and if movement cancelled it the user was scrolling.
    const wasPending = timer.current !== null;
    origin.current = null;
    stop();
    if (!wasPending) return;

    const now = Date.now();
    taps.current = taps.current.filter((at) => now - at < TAP_WINDOW_MS).concat(now);
    if (taps.current.length >= TAP_COUNT) {
      taps.current = [];
      onTrigger();
    }
  }, [onTrigger, stop]);

  /**
   * Holds the element so the effect can bind to it, and re-runs the effect when it appears.
   * A plain `useRef` would not: assigning to `.current` does not re-render.
   */
  const [node, setNode] = useState<HTMLElement | null>(null);
  const ref = useCallback((el: HTMLElement | null) => setNode(el), []);

  useEffect(() => {
    if (!node) return;

    const onTouchStart = (e: TouchEvent) => {
      // Non-passive, so this actually takes effect: it suppresses the selection callout and
      // the image drag that would otherwise cancel the gesture. Safe on a small,
      // non-scrolling target where there is no scroll behaviour to lose.
      if (e.cancelable) e.preventDefault();
      const p = e.touches[0];
      if (p) begin(p.clientX, p.clientY);
    };
    const onTouchMove = (e: TouchEvent) => {
      const p = e.touches[0];
      if (p) move(p.clientX, p.clientY);
    };
    const onMouseDown = (e: MouseEvent) => begin(e.clientX, e.clientY);
    const onMouseMove = (e: MouseEvent) => move(e.clientX, e.clientY);
    const onLeave = () => {
      origin.current = null;
      stop();
    };
    /**
     * The WebView can still cancel the pointer stream even with the above in place — a
     * system gesture, a notification, the screen being touched elsewhere. Treating cancel as
     * an end rather than as an abort means such a hold still counts towards the tap
     * fallback instead of being lost silently.
     */
    const onCancel = () => end();

    node.addEventListener('touchstart', onTouchStart, { passive: false });
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('touchend', end);
    node.addEventListener('touchcancel', onCancel);
    node.addEventListener('mousedown', onMouseDown);
    node.addEventListener('mousemove', onMouseMove);
    node.addEventListener('mouseup', end);
    node.addEventListener('mouseleave', onLeave);

    return () => {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', onCancel);
      node.removeEventListener('mousedown', onMouseDown);
      node.removeEventListener('mousemove', onMouseMove);
      node.removeEventListener('mouseup', end);
      node.removeEventListener('mouseleave', onLeave);
      stop();
    };
  }, [node, begin, move, end, stop]);

  return { ref, progress };
}
