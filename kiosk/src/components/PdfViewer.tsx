/**
 * Offline PDF viewer built on pdf.js.
 *
 * The engine and its worker are bundled into the APK — nothing is ever fetched from a CDN —
 * and the bytes come from IndexedDB, so this works with the network cable unplugged. The
 * engine is the pdf.js legacy build so it also runs on older Android WebViews; see
 * `src/lib/pdfEngine.ts`.
 *
 * Two layouts, chosen by the caller from available width:
 *
 *   - `overlay` — covers the screen. Right for a phone, where a side-by-side split would
 *     leave neither pane usable.
 *   - `pane` — sits beside the document list, which stays visible so the operator can move
 *     between documents without going back. The list can be collapsed, and full screen hides
 *     everything but the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjs, PDF_OPTIONS } from '../lib/pdfEngine';
import { Icon } from './Icon';
import { getFile, putFile } from '../lib/store';
import { checkPdf, readBundledPdf, errText } from '../lib/pdfBytes';
import { useZoomPan } from '../lib/useZoomPan';
import { createPageTurn, type Axis, type Dir, type PageTurn } from '../lib/pageTurn';
import { t, formatDate } from '../lib/i18n';
import { docTitle, docFile } from '../lib/types';
import type { Doc, Lang } from '../lib/types';

type FitMode = 'width' | 'page' | 'custom';

/**
 * Why a document would not open. Each needs different advice, and getting this wrong wastes
 * a site visit: the first build showed "connect the display to the network" for a file that
 * was already on the device and perfectly intact.
 */
type ErrKind =
  /** Nothing stored and nothing bundled: it really does need a sync. */
  | 'notCached'
  /** Bytes present but failed validation — wrong length, no header, no trailer. */
  | 'damaged'
  /** Bytes good, engine refused them. A platform problem, not a content problem. */
  | 'engine';

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
/** Stage padding, kept in step with `.vw__stage` in app.css. */
const STAGE_PAD = 44;
/** Breathing room kept around a page that is larger than the stage. Half of STAGE_PAD on
 *  each side, so a fit-to-width page lands exactly on this margin. */
const EDGE_PAD = 22;
/** How many finished pages to keep. */
const CACHE_MAX_PAGES = 4;
/** A page bigger than this is not cached: at 2x device pixels it is already ~24MB. */
const CACHE_MAX_PIXELS = 6_000_000;
/** Long enough that the neighbours are drawn after the current page has settled. */
const PREFETCH_DELAY_MS = 260;
/** A turn faster than this needs no feedback — it has already happened. */
const DIM_AFTER_MS = 140;
/** Long enough to let a rotation or a collapsing list finish, short enough not to be felt. */
const RESIZE_SETTLE_MS = 90;

interface Props {
  doc: Doc;
  lang: Lang;
  /**
   * Leaves the document for the home screen. This is the prominent one, because the panel
   * is on a wall and the person who has finished reading walks away — the next person should
   * not arrive at somebody else's page 7.
   */
  onClose: () => void;
  /**
   * Back to the list of the category this document came from.
   *
   * Both exits are offered deliberately. Making the only way out go all the way home would
   * cost three touches to read two documents from the same category, which is exactly what
   * people do with the fire plans; making the only way out go back to the list would leave
   * the panel showing a list nobody chose. So: a quiet arrow for the reader who is still
   * working, and a clear Home for the one who has finished.
   */
  onBack?: () => void;
  onActivity: () => void;
  /** `overlay` on a narrow screen, `pane` beside the list on a wide one. */
  variant?: 'overlay' | 'pane';
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Pane layout only: whether the list beside this is currently hidden. */
  listHidden?: boolean;
  onToggleList?: () => void;
}

export function PdfViewer({
  doc,
  lang,
  onClose,
  onBack,
  onActivity,
  variant = 'overlay',
  fullscreen = false,
  onToggleFullscreen,
  listHidden = false,
  onToggleList,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** The clipping box the turning sheets are laid over. The stage itself cannot be used:
   *  it scrolls, and anything absolutely positioned inside it would scroll with the page. */
  const wrapRef = useRef<HTMLDivElement>(null);
  const turnRef = useRef<PageTurn | null>(null);
  /** The page a committed turn is heading for, so the sheets know what they are showing. */
  const turnDirRef = useRef<Dir>(1);
  /**
   * A committed turn ends twice: the sheet stops moving, and the real page finishes drawing
   * behind it. The sheets are only cleared once both have happened, which is what keeps the
   * swap invisible instead of flashing the old page for a frame.
   */
  const settleRef = useRef({ anim: false, paint: false, pending: false });
  /** Guards against an older render finishing after a newer one and overwriting it. */
  const renderSeq = useRef(0);
  /** A pending request to keep one point of the page under one point of the screen across
   *  the next render, so zooming does not throw away the reader's place. */
  const anchorRef = useRef<{ u: number; v: number; x: number; y: number } | null>(null);
  /*
    Finished pages, keyed by page number and the scale they were drawn at. A page turn that
    hits this cache is a single copy of pixels instead of a fresh parse and rasterise, which
    is the difference between a page appearing at once and appearing after a visible pause.
    The pages either side of the current one are drawn into it while the panel is idle, so
    swiping forwards or backwards normally lands on a page that is already finished.
  */
  const pageCache = useRef(new Map<string, HTMLCanvasElement>());
  const prerenderRef = useRef<{ cancel: () => void } | null>(null);
  const idleRef = useRef<number | null>(null);
  /** Pending "this turn is taking a moment" dim; see the page-turn handler. */
  const dimRef = useRef<number | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  /** The scale actually on screen, so pinch and the zoom buttons agree with the fit modes. */
  const renderedScale = useRef(1);

  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(doc.pageCount || 0);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState<FitMode>('width');
  /** True from the moment a swipe turns the page until the new one is on screen. */
  const [turning, setTurning] = useState(false);
  /**
   * The rendered scale, mirrored into state purely so the percentage in the toolbar updates.
   * `renderedScale` is a ref because the gesture handlers read it without wanting a re-render;
   * this is written only when the value really changes, so it cannot loop with `render`.
   */
  const [shownScale, setShownScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Technical cause, shown under the message so a fault can be diagnosed on the panel. */
  const [detail, setDetail] = useState<string | null>(null);
  const [errKind, setErrKind] = useState<ErrKind>('notCached');

  // ---- load the document once -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setPageNum(1);
    // Pages of the previous document must not be shown for this one, and holding onto their
    // canvases would keep tens of megabytes alive for a document nobody is reading.
    pageCache.current.clear();

    (async () => {
      try {
        // The Bulgarian and the English edition are separate PDFs; open the one for the
        // language on screen, and fall back to the other so a language switch inside an
        // open document never lands on a blank viewer.
        const chosen = docFile(doc, lang) ?? docFile(doc, lang === 'bg' ? 'en' : 'bg');
        if (!chosen) throw new Error('няма файл за този документ');
        const cached = await getFile(chosen.versionId);
        let bytes = cached?.bytes ?? null;
        let why: string | null = null;

        // Never hand pdf.js a stream we have not checked. Cached bytes can be short if they
        // were stored by an older build that did not validate on import.
        const check = checkPdf(bytes, chosen.sizeBytes);
        if (!check.ok) {
          why = check.reason ?? null;
          // Self-repair: re-read the copy bundled in the app and replace the bad entry.
          const reread = await readBundledPdf(chosen.versionId, chosen.sizeBytes);
          if ('bytes' in reread) {
            bytes = reread.bytes;
            await putFile({
              versionId: chosen.versionId,
              documentId: doc.id,
              bytes: reread.bytes,
              sizeBytes: reread.bytes.byteLength,
              sha256: chosen.sha256,
              cachedAt: new Date().toISOString(),
            }).catch(() => {}); // A read-only store must not block viewing.
            why = null;
          } else if (!cached) {
            if (!cancelled) {
              setError(t(lang, 'notCached'));
              setErrKind('notCached');
              setDetail(reread.error);
              setLoading(false);
            }
            return;
          } else {
            // Distinguish the two copies: the stored one and the bundled one.
            why = why === reread.error ? why : `съхранено: ${why} · APK: ${reread.error}`;
          }
        }

        if (!bytes || why) {
          if (!cancelled) {
            setError(t(lang, 'openFailed'));
            setErrKind('damaged');
            setDetail(why);
            setLoading(false);
          }
          return;
        }

        // pdf.js takes ownership of the buffer, so hand it a copy.
        const data = new Uint8Array(bytes.slice(0));
        const pdf = await pdfjs.getDocument({ data, ...PDF_OPTIONS }).promise;
        if (cancelled) {
          pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        setPageCount(pdf.numPages);
        setLoading(false);
      } catch (e) {
        // The bytes were validated above, so anything thrown here came from the engine.
        if (!cancelled) {
          setError(t(lang, 'openFailed'));
          setErrKind('engine');
          setDetail(errText(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      prerenderRef.current?.cancel();
      if (idleRef.current !== null) clearTimeout(idleRef.current);
      if (dimRef.current !== null) clearTimeout(dimRef.current);
      pageCache.current.clear();
      pdfRef.current?.destroy();
      pdfRef.current = null;
    };
    // Re-running on a language change is deliberate: the other language is a different PDF.
  }, [doc.id, docFile(doc, lang)?.versionId, lang]);

  /*
    Centres the page by padding the stage rather than by centring a flex item.

    Flex centring cannot be used here: once the page is wider than the stage the overflow
    goes off both sides, and the part past the start edge sits at a negative offset that
    scrollLeft can never reach, so the left of a zoomed page was unreachable. Padding puts
    that space inside the scrollable area, which centres a small page and leaves a large one
    fully pannable. Recomputed on every render because the page size changes with the zoom.
  */
  const centre = useCallback((cssW: number, cssH: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const padX = Math.max(EDGE_PAD, Math.round((stage.clientWidth - cssW) / 2));
    const padY = Math.max(EDGE_PAD, Math.round((stage.clientHeight - cssH) / 2));
    stage.style.padding = `${padY}px ${padX}px`;
  }, []);

  /** Scale is part of the key: the same page at a different zoom is a different picture. */
  const cacheKey = (n: number, sc: number) => `${n}@${sc.toFixed(3)}`;

  /** Clears the turning sheets, but only once the page underneath them is really there. */
  const settleTurn = useCallback(() => {
    const s = settleRef.current;
    if (!s.pending || !s.anim || !s.paint) return;
    s.pending = false;
    s.anim = false;
    s.paint = false;
    turnRef.current?.finish();
  }, []);

  /** Keeps the cache small. Four pages at a comfortable reading zoom is a few tens of
   *  megabytes, which a panel can hold; a deeply zoomed page is not worth keeping at all. */
  const remember = useCallback((key: string, c: HTMLCanvasElement) => {
    if (c.width * c.height > CACHE_MAX_PIXELS) return;
    const cache = pageCache.current;
    cache.delete(key);
    cache.set(key, c);
    while (cache.size > CACHE_MAX_PAGES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }, []);

  /** Draws a page into an off-screen canvas without touching the screen. */
  const renderToCache = useCallback(
    async (n: number, sc: number, dpr: number) => {
      const pdf = pdfRef.current;
      if (!pdf || n < 1 || n > pdf.numPages) return;
      const key = cacheKey(n, sc);
      if (pageCache.current.has(key)) return;
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: sc });
      const c = document.createElement('canvas');
      c.width = Math.floor(viewport.width * dpr);
      c.height = Math.floor(viewport.height * dpr);
      if (c.width * c.height > CACHE_MAX_PIXELS) return;
      const ctx = c.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, viewport.width, viewport.height);
      const task = page.render({ canvasContext: ctx, viewport });
      prerenderRef.current = task;
      await task.promise;
      prerenderRef.current = null;
      remember(key, c);
    },
    [remember]
  );

  /*
    Draw the neighbours once the panel has nothing better to do. Deliberately not awaited by
    the caller: a pre-render must never delay the page the reader is actually looking at, and
    if it is still going when they turn the page it is cancelled rather than finished.
  */
  const prefetchNeighbours = useCallback(
    (n: number, sc: number, dpr: number) => {
      if (idleRef.current !== null) {
        clearTimeout(idleRef.current);
        idleRef.current = null;
      }
      idleRef.current = window.setTimeout(() => {
        idleRef.current = null;
        void (async () => {
          try {
            await renderToCache(n + 1, sc, dpr);
            await renderToCache(n - 1, sc, dpr);
          } catch {
            // A cancelled or failed pre-render is not a problem worth reporting: the page
            // will simply be drawn normally when it is asked for.
          }
        })();
      }, PREFETCH_DELAY_MS);
    },
    [renderToCache]
  );

  // ---- render the current page ------------------------------------------------
  const render = useCallback(async () => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!pdf || !canvas || !stage) return;

    renderTaskRef.current?.cancel();
    const seq = ++renderSeq.current;

    try {
      const page = await pdf.getPage(pageNum);
      const base = page.getViewport({ scale: 1 });

      // Fit modes are computed against the live stage size, so rotation, a collapsed list
      // and full screen are all handled without hard-coded panel dimensions.
      // Layout is not always settled the first time this runs, and a zero-sized stage would
      // otherwise produce a non-finite scale and a canvas that cannot be allocated.
      const availW = Math.max((stage.clientWidth || window.innerWidth || 1080) - STAGE_PAD, 240);
      const availH = Math.max((stage.clientHeight || window.innerHeight || 1920) - STAGE_PAD, 240);
      let effective = scale;
      if (fit === 'width') effective = availW / base.width;
      else if (fit === 'page') effective = Math.min(availW / base.width, availH / base.height);
      // Guard against a degenerate page box (base.width can be 0 on a malformed PDF).
      if (!Number.isFinite(effective) || effective <= 0) effective = 1;
      effective = Math.min(effective, MAX_SCALE);
      renderedScale.current = effective;
      setShownScale((s) => (Math.abs(s - effective) < 0.005 ? s : effective));

      // Cap the backing-store resolution: a 24" panel gains nothing above ~2x and very large
      // scales can exhaust WebView canvas memory.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: effective });

      const cssW = Math.floor(viewport.width);
      const cssH = Math.floor(viewport.height);

      /** Copies a finished page onto the panel, then re-centres and re-anchors it. */
      const paint = (src: HTMLCanvasElement) => {
        canvas.width = src.width;
        canvas.height = src.height;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(src, 0, 0);
        centre(cssW, cssH);

        /*
          Put the anchored point back under the finger. Reading the canvas rect here forces
          the layout that the new size and padding just invalidated, so the correction is
          measured against where the page actually ended up rather than where it was
          predicted to be.
        */
        const anchor = anchorRef.current;
        if (anchor) {
          anchorRef.current = null;
          const r = canvas.getBoundingClientRect();
          stage.scrollLeft += r.left + anchor.u * r.width - anchor.x;
          stage.scrollTop += r.top + anchor.v * r.height - anchor.y;
        }
        if (dimRef.current !== null) {
          clearTimeout(dimRef.current);
          dimRef.current = null;
        }
        setTurning(false);
        // One frame later, so the browser has actually put these pixels on the panel before
        // the sheet covering them is taken away.
        if (settleRef.current.pending) {
          requestAnimationFrame(() => {
            settleRef.current.paint = true;
            settleTurn();
          });
        }
      };

      // Already drawn at this exact size — most page turns land here, and cost one copy.
      const key = cacheKey(pageNum, effective);
      const hit = pageCache.current.get(key);
      if (hit) {
        paint(hit);
        remember(key, hit); // Touch it, so it is the last of the four to be dropped.
        prefetchNeighbours(pageNum, effective, dpr);
        return;
      }

      /*
        Draw into an off-screen canvas and copy the finished page across in one go.

        Rendering straight into the visible canvas means clearing it first, so every page
        turn showed an empty rectangle for as long as the render took — on a swipe, with the
        page dimmed, that looked like the document had failed rather than like it was
        turning. Off-screen, the page that is already on the panel stays there untouched
        until its replacement is complete.
      */
      const off = document.createElement('canvas');
      off.width = Math.floor(viewport.width * dpr);
      off.height = Math.floor(viewport.height * dpr);

      const octx = off.getContext('2d', { alpha: false });
      if (!octx) return;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, viewport.width, viewport.height);

      // A pre-render of a neighbour must not compete with the page being waited on.
      prerenderRef.current?.cancel();
      const task = page.render({ canvasContext: octx, viewport });
      renderTaskRef.current = task;
      await task.promise;
      renderTaskRef.current = null;

      // A newer render may have been started and finished while this one was waiting; only
      // the most recent one is allowed to reach the screen.
      if (renderSeq.current !== seq) return;

      paint(off);
      remember(key, off);
      prefetchNeighbours(pageNum, effective, dpr);
    } catch (e) {
      if ((e as Error)?.name !== 'RenderingCancelledException') {
        setTurning(false);
        setError(t(lang, 'openFailed'));
        setErrKind('engine');
        setDetail(errText(e));
      }
    }
  }, [pageNum, scale, fit, lang, centre, remember, prefetchNeighbours, settleTurn]);

  useEffect(() => {
    if (!loading && !error) void render();
  }, [loading, error, render]);

  // Re-render when the stage changes size: rotation, collapsing the list, full screen.
  // ResizeObserver catches the layout changes that never fire a window resize.
  useEffect(() => {
    if (loading || error) return;
    const stage = stageRef.current;

    /*
      Coalesce the burst. Rotating the panel, collapsing the list or entering full screen all
      fire a run of size changes, and rasterising the page for each intermediate size wastes
      the work and leaves the page visibly catching up. Only the size it settles at is drawn.
    */
    let pending: number | null = null;
    const schedule = () => {
      if (pending !== null) clearTimeout(pending);
      pending = window.setTimeout(() => {
        pending = null;
        void render();
      }, RESIZE_SETTLE_MS);
    };

    window.addEventListener('resize', schedule);

    let ro: ResizeObserver | null = null;
    if (stage && typeof ResizeObserver !== 'undefined') {
      let last = `${stage.clientWidth}x${stage.clientHeight}`;
      ro = new ResizeObserver(() => {
        const now = `${stage.clientWidth}x${stage.clientHeight}`;
        if (now === last) return; // Ignore the observer's own initial callback.
        last = now;
        schedule();
      });
      ro.observe(stage);
    }

    return () => {
      window.removeEventListener('resize', schedule);
      if (pending !== null) clearTimeout(pending);
      ro?.disconnect();
    };
  }, [render, loading, error]);

  // Reset scroll to the top of each new page.
  useEffect(() => {
    stageRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [pageNum]);

  const act = (fn: () => void) => () => {
    onActivity();
    fn();
  };

  const go = (delta: number) => {
    // The buttons have no sheet animation to hide the wait, so a turn that has to rasterise
    // still dims the page. A cached neighbour appears before the timer fires and never does.
    if (dimRef.current !== null) clearTimeout(dimRef.current);
    dimRef.current = window.setTimeout(() => {
      dimRef.current = null;
      setTurning(true);
    }, DIM_AFTER_MS);
    setPageNum((p) => Math.min(Math.max(1, p + delta), Math.max(1, pageCount)));
  };

  /** Whether there is a page to swipe to. Beyond the ends the gesture rubber-bands back
   *  rather than doing nothing, so the reader can tell the panel felt the swipe. */
  const canTurn = useCallback(
    (dir: 1 | -1) => (dir === 1 ? pageNum < pageCount : pageNum > 1),
    [pageNum, pageCount]
  );

  /** The background the sheets are painted on, so a page smaller than the stage does not
   *  arrive on a white rectangle. Read from the stylesheet rather than duplicated here. */
  /**
   * The colour to fill a sheet with around the page.
   *
   * It has to be the colour the reader is actually looking at, so it walks up from the stage
   * until it finds an element that paints something: the stage itself is transparent, and
   * filling the sheets with a guessed navy put a visibly different shade behind the paper for
   * the length of every turn.
   */
  const stageBg = useCallback(() => {
    let el: HTMLElement | null = stageRef.current;
    while (el) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      el = el.parentElement;
    }
    return '#2c3142';
  }, []);

  /** Snapshots the panel exactly as the reader sees it, zoom, scroll and all. */
  const paintCurrent = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      ctx.fillStyle = stageBg();
      ctx.fillRect(0, 0, w, h);
      const box = wrapRef.current;
      const canvas = canvasRef.current;
      if (!box || !canvas || !canvas.width) return;
      const br = box.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      ctx.drawImage(canvas, cr.left - br.left, cr.top - br.top, cr.width, cr.height);
    },
    [stageBg]
  );

  /**
   * Paints the page being turned to, as it will look when it arrives: at the top, centred the
   * same way `centre` will centre it. Only pages already in the cache can be drawn, which is
   * what the neighbour pre-render exists for; a miss returns false and the sheet is filled in
   * later by `refreshTarget`.
   */
  const paintTarget = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, dir: Dir) => {
      ctx.fillStyle = stageBg();
      ctx.fillRect(0, 0, w, h);
      const src = pageCache.current.get(cacheKey(pageNum + dir, renderedScale.current));
      if (!src) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = src.width / dpr;
      const cssH = src.height / dpr;
      const padX = Math.max(EDGE_PAD, Math.round((w - cssW) / 2));
      const padY = Math.max(EDGE_PAD, Math.round((h - cssH) / 2));
      ctx.drawImage(src, padX, padY, cssW, cssH);
      return true;
    },
    [pageNum]
  );

  /*
    The two painters, held in a ref.

    They have to be reachable from the sheet layer without being dependencies of the effect
    that builds it. `paintTarget` closes over the current page number, so passing it directly
    made the effect re-run on every page change — which tore the sheet layer down and built a
    new one *while the turn it belonged to was still animating*, leaving the document hidden
    behind a layer that no longer knew it was showing anything. That is the blank screen after
    a swipe.
  */
  const paintRef = useRef({ paintCurrent, paintTarget });
  paintRef.current = { paintCurrent, paintTarget };

  // The sheets are built once and reused. Rebuilding them per gesture meant allocating two
  // full-screen canvases at the moment the finger went down, which is the one moment in the
  // whole interaction that must not stall.
  useEffect(() => {
    const box = wrapRef.current;
    if (!box || loading || error) return;
    const turn = createPageTurn({
      container: box,
      paintCurrent: (ctx, w, h) => paintRef.current.paintCurrent(ctx, w, h),
      paintTarget: (ctx, w, h, dir) => paintRef.current.paintTarget(ctx, w, h, dir),
    });
    turnRef.current = turn;
    return () => {
      turnRef.current = null;
      settleRef.current = { anim: false, paint: false, pending: false };
      turn.destroy();
    };
  }, [loading, error]);

  /*
    A drag turns the page as a sheet of paper, not as a slide transition: see `pageTurn.ts`
    for which sheet moves and why. What happens here is only the plumbing — staging the
    sheets when the gesture declares itself, feeding it the finger, and swapping the real
    page in behind the sheets once it commits.
  */
  const onTurnStart = useCallback(
    (axis: Axis, dir: Dir) => {
      const turn = turnRef.current;
      if (!turn) return false;
      // A turn already settling must be cleared, or its sheets would be reused mid-flight.
      if (turn.active()) turn.finish();
      turnDirRef.current = dir;
      if (!turn.begin(axis, dir)) return false;
      /*
        The page being turned to is normally already drawn, because the neighbours are
        pre-rendered while the panel is idle. When it is not — straight after opening a
        document, or after a zoom — the sheet starts blank and is filled in the moment the
        render lands, which is far better than refusing the gesture.
      */
      if (!pageCache.current.has(cacheKey(pageNum + dir, renderedScale.current))) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        void renderToCache(pageNum + dir, renderedScale.current, dpr)
          .then(() => turnRef.current?.refreshTarget())
          .catch(() => {});
      }
      onActivity();
      return true;
    },
    [pageNum, renderToCache, onActivity]
  );

  const onTurnMove = useCallback((offset: number) => {
    turnRef.current?.move(offset);
  }, []);

  const onTurnEnd = useCallback(
    (committed: boolean, velocity: number) => {
      const turn = turnRef.current;
      if (!turn) return;
      const dir = turnDirRef.current;

      if (committed) {
        /*
          Change the page now rather than when the animation ends. The sheets are covering
          the stage for the whole of that animation, so the rasterising, the re-centring and
          the scroll reset all happen out of sight — by the time the sheets lift, the page is
          usually already there and the turn costs nothing.
        */
        settleRef.current = { anim: false, paint: false, pending: true };
        setPageNum((p) => Math.min(Math.max(1, p + dir), Math.max(1, pageCount)));
      }

      void turn.end(committed, velocity).then(() => {
        if (!committed) return;
        settleRef.current.anim = true;
        settleTurn();
      });
      onActivity();
    },
    [pageCount, onActivity, settleTurn]
  );

  /** Applies an absolute scale, leaving whichever fit mode was active. */
  const applyScale = useCallback(
    (next: number, anchor?: { u: number; v: number; x: number; y: number }) => {
      if (anchor) anchorRef.current = anchor;
      setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, next)));
      setFit('custom');
    },
    []
  );

  /** A pinch or a ctrl+wheel, centred on the point it was made about. */
  const onZoomCommit = useCallback(
    (z: { scale: number; u: number; v: number; x: number; y: number }) => {
      applyScale(z.scale, { u: z.u, v: z.v, x: z.x, y: z.y });
      onActivity();
    },
    [applyScale, onActivity]
  );

  const zoom = (factor: number) => applyScale(renderedScale.current * factor);

  const currentScale = useCallback(() => renderedScale.current, []);

  /** Double-tap alternates between the whole page and a comfortable reading magnification. */
  const onDoubleTap = useCallback(
    (at: { u: number; v: number; x: number; y: number }) => {
      /*
        Zoom relative to what is on screen, not to a fixed number.

        A double tap used to go to scale 2 exactly. On the portrait panel fit-width is
        already about 1.74, so a double tap there magnified the page by 15% — it read as a
        misfire rather than as a zoom. Doubling whatever is currently rendered means the
        gesture does the same visible thing on every screen.
      */
      if (fit === 'custom') setFit('width');
      // Zoom towards what was tapped rather than towards the middle of the page.
      else applyScale(Math.min(MAX_SCALE, renderedScale.current * 2), at);
    },
    [fit, applyScale]
  );

  useZoomPan({
    stageRef,
    pageRef: canvasRef,
    canTurn,
    onTurnStart,
    onTurnMove,
    onTurnEnd,
    currentScale,
    onZoomCommit,
    onDoubleTap,
    minScale: MIN_SCALE,
    maxScale: MAX_SCALE,
    onActivity,
    enabled: !loading && !error,
  });

  // Keyboard support — handy for a wireless keyboard during setup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (fullscreen && onToggleFullscreen) onToggleFullscreen();
        else (onBack || onClose)();
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      else if (e.key === 'f' || e.key === 'F') onToggleFullscreen?.();
      else return;
      onActivity();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, onClose, onBack, onActivity, fullscreen, onToggleFullscreen]);

  const hint =
    errKind === 'notCached'
      ? t(lang, 'notCachedHint')
      : errKind === 'damaged'
        ? t(lang, 'openFailedHint')
        : t(lang, 'engineFailedHint');

  const cls = [
    'vw',
    variant === 'pane' ? 'vw--pane' : 'vw--overlay',
    fullscreen ? 'vw--full' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} onPointerDown={onActivity}>
      <div className="vw__bar">
        {/*
          In the pane layout the list is right there, so a Back button would be noise; the
          useful control is one that hides the list to give the page the whole width. In the
          overlay layout Back is the only way out.
        */}
        {variant === 'pane' && onToggleList ? (
          <button
            className={`vbtn ${listHidden ? '' : 'vbtn--on'}`}
            onClick={act(onToggleList)}
            aria-label={t(lang, listHidden ? 'showList' : 'hideList')}
            title={t(lang, listHidden ? 'showList' : 'hideList')}
          >
            <Icon name="panelLeft" size={22} />
          </button>
        ) : (
          <button
            className="vbtn vbtn--back"
            onClick={act(onBack || onClose)}
            aria-label={t(lang, 'back')}
            title={t(lang, 'back')}
          >
            <Icon name="arrowLeft" size={22} />
            <span className="vbtn__lbl">{t(lang, 'back')}</span>
          </button>
        )}

        <div className="vw__ttl">
          <div className="vw__t">{docTitle(doc, lang)}</div>
          <div className="vw__s">
            {t(lang, 'version')} {doc.versionNumber} · {t(lang, 'updated')}{' '}
            {formatDate(doc.updatedAt, lang)}
            {pageCount ? ` · ${pageCount} ${t(lang, 'pages')}` : ''}
          </div>
        </div>

        {onToggleFullscreen && (
          <button
            className="vbtn"
            onClick={act(onToggleFullscreen)}
            aria-label={t(lang, fullscreen ? 'exitFullscreen' : 'fullscreen')}
            title={t(lang, fullscreen ? 'exitFullscreen' : 'fullscreen')}
          >
            <Icon name={fullscreen ? 'collapse' : 'expand'} size={22} />
          </button>
        )}

        {/* The way out, and it says where it goes. An unlabelled cross on a wall panel is
            read as "close this popup", not as "leave the document". */}
        <button
          className="vbtn vbtn--exit"
          onClick={act(onClose)}
          aria-label={t(lang, 'home')}
          title={t(lang, 'home')}
        >
          <Icon name="x" size={24} />
          <span className="vbtn__lbl">{t(lang, 'home')}</span>
        </button>
      </div>

      {loading ? (
        <div className="vw__load">
          <div className="spin" />
          <div>{t(lang, 'loading')}</div>
        </div>
      ) : error ? (
        <div className="vw__load">
          <div className="empty__ic" style={{ background: 'rgba(255,255,255,.14)', color: '#fff' }}>
            <Icon name={errKind === 'notCached' ? 'wifiOff' : 'doc'} size={44} />
          </div>
          <div className="vw__errt">{error}</div>
          <div className="vw__errh">{hint}</div>
          {detail && <div className="vw__errd">{detail}</div>}
        </div>
      ) : (
        <div className="vw__stagewrap" ref={wrapRef}>
          <div className="vw__stage" ref={stageRef}>
            <canvas
              className={`vw__canvas ${turning ? 'vw__canvas--turning' : ''}`}
              ref={canvasRef}
            />
          </div>
        </div>
      )}

      {!loading && !error && (
        <div className="vw__foot">
          <button className="vbtn" onClick={act(() => go(-1))} disabled={pageNum <= 1}>
            <Icon name="chevronLeft" size={22} />
            <span className="vbtn__lbl">{t(lang, 'prevPage')}</span>
          </button>
          {/*
            Two forms of the same indicator. On a phone the full "Стр. 1 от 6" plus five
            controls does not fit 412px, and the toolbar overlapped itself — the next-page
            arrow was drawn on top of the text. CSS cannot shorten a string, so the short
            form is rendered too and the stylesheet picks one.
          */}
          <div className="vw__pg">
            <span className="vw__pg-long">
              {t(lang, 'page')} {pageNum} {t(lang, 'of')} {pageCount || '—'}
            </span>
            <span className="vw__pg-short">
              {pageNum}/{pageCount || '—'}
            </span>
          </div>
          <button className="vbtn" onClick={act(() => go(1))} disabled={pageNum >= pageCount}>
            <span className="vbtn__lbl">{t(lang, 'nextPage')}</span>
            <Icon name="chevronRight" size={22} />
          </button>

          <div className="vw__sep" />

          <button className="vbtn" onClick={act(() => zoom(1 / 1.25))} aria-label={t(lang, 'zoomOut')}>
            <Icon name="minus" size={22} />
          </button>
          <div className="vw__pct">{Math.round(shownScale * 100)}%</div>
          <button className="vbtn" onClick={act(() => zoom(1.25))} aria-label={t(lang, 'zoomIn')}>
            <Icon name="plus" size={22} />
          </button>
          <button
            className="vbtn"
            onClick={act(() => setFit(fit === 'width' ? 'page' : 'width'))}
          >
            <Icon name="grid" size={20} />
            <span className="vbtn__lbl">
              {fit === 'width' ? t(lang, 'fitPage') : t(lang, 'fitWidth')}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
