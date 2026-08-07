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
import { t, formatDate } from '../lib/i18n';
import { docTitle } from '../lib/types';
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

interface Props {
  doc: Doc;
  lang: Lang;
  onClose: () => void;
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
  onActivity,
  variant = 'overlay',
  fullscreen = false,
  onToggleFullscreen,
  listHidden = false,
  onToggleList,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** Pages are drawn here first and copied across when finished; see render(). */
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  /** Guards against an older render finishing after a newer one and overwriting it. */
  const renderSeq = useRef(0);
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

    (async () => {
      try {
        const cached = await getFile(doc.versionId);
        let bytes = cached?.bytes ?? null;
        let why: string | null = null;

        // Never hand pdf.js a stream we have not checked. Cached bytes can be short if they
        // were stored by an older build that did not validate on import.
        const check = checkPdf(bytes, doc.sizeBytes);
        if (!check.ok) {
          why = check.reason ?? null;
          // Self-repair: re-read the copy bundled in the app and replace the bad entry.
          const reread = await readBundledPdf(doc.versionId, doc.sizeBytes);
          if ('bytes' in reread) {
            bytes = reread.bytes;
            await putFile({
              versionId: doc.versionId,
              documentId: doc.id,
              bytes: reread.bytes,
              sizeBytes: reread.bytes.byteLength,
              sha256: doc.sha256,
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
      pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [doc.versionId, lang]);

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

      /*
        Draw into an off-screen canvas and copy the finished page across in one go.

        Rendering straight into the visible canvas means clearing it first, so every page
        turn showed an empty rectangle for as long as the render took — on a swipe, with the
        page dimmed, that looked like the document had failed rather than like it was
        turning. Off-screen, the page that is already on the panel stays there untouched
        until its replacement is complete.
      */
      const off = offscreenRef.current || document.createElement('canvas');
      offscreenRef.current = off;
      off.width = Math.floor(viewport.width * dpr);
      off.height = Math.floor(viewport.height * dpr);

      const octx = off.getContext('2d', { alpha: false });
      if (!octx) return;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, viewport.width, viewport.height);

      const task = page.render({ canvasContext: octx, viewport });
      renderTaskRef.current = task;
      await task.promise;
      renderTaskRef.current = null;

      // A newer render may have been started and finished while this one was waiting; only
      // the most recent one is allowed to reach the screen.
      if (renderSeq.current !== seq) return;

      canvas.width = off.width;
      canvas.height = off.height;
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(off, 0, 0);
      setTurning(false);
    } catch (e) {
      if ((e as Error)?.name !== 'RenderingCancelledException') {
        setTurning(false);
        setError(t(lang, 'openFailed'));
        setErrKind('engine');
        setDetail(errText(e));
      }
    }
  }, [pageNum, scale, fit, lang]);

  useEffect(() => {
    if (!loading && !error) void render();
  }, [loading, error, render]);

  // Re-render when the stage changes size: rotation, collapsing the list, full screen.
  // ResizeObserver catches the layout changes that never fire a window resize.
  useEffect(() => {
    if (loading || error) return;
    const stage = stageRef.current;
    const onResize = () => void render();
    window.addEventListener('resize', onResize);

    let ro: ResizeObserver | null = null;
    if (stage && typeof ResizeObserver !== 'undefined') {
      let last = `${stage.clientWidth}x${stage.clientHeight}`;
      ro = new ResizeObserver(() => {
        const now = `${stage.clientWidth}x${stage.clientHeight}`;
        if (now === last) return; // Ignore the observer's own initial callback.
        last = now;
        void render();
      });
      ro.observe(stage);
    }

    return () => {
      window.removeEventListener('resize', onResize);
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

  const go = (delta: number) =>
    setPageNum((p) => Math.min(Math.max(1, p + delta), Math.max(1, pageCount)));

  /** Whether there is a page to swipe to. Beyond the ends the gesture rubber-bands back
   *  rather than doing nothing, so the reader can tell the panel felt the swipe. */
  const canTurn = useCallback(
    (dir: 1 | -1) => (dir === 1 ? pageNum < pageCount : pageNum > 1),
    [pageNum, pageCount]
  );

  /*
    A swipe turns the page and dims it until the new one has been drawn. The page is not
    animated off the screen: the canvas keeps showing the old page until pdf.js has finished
    rendering, so sliding it away would slide the wrong page out and then snap. A short dim
    is honest about what is happening and cannot look broken on a slow panel.
  */
  const onSwipe = useCallback(
    (dir: 1 | -1) => {
      setTurning(true);
      onActivity();
      setPageNum((p) => Math.min(Math.max(1, p + dir), Math.max(1, pageCount)));
    },
    [pageCount, onActivity]
  );

  /** Applies an absolute scale, leaving whichever fit mode was active. */
  const applyScale = useCallback((next: number) => {
    setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, next)));
    setFit('custom');
  }, []);

  const zoom = (factor: number) => applyScale(renderedScale.current * factor);

  const currentScale = useCallback(() => renderedScale.current, []);

  /** Double-tap alternates between the whole page and a comfortable reading magnification. */
  const onDoubleTap = useCallback(() => {
    if (fit === 'custom' && renderedScale.current > 1.05) setFit('page');
    else applyScale(2);
  }, [fit, applyScale]);

  useZoomPan({
    stageRef,
    pageRef: canvasRef,
    canTurn,
    onSwipe,
    currentScale,
    onScale: applyScale,
    onDoubleTap,
    onActivity,
    enabled: !loading && !error,
  });

  // Keyboard support — handy for a wireless keyboard during setup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (fullscreen && onToggleFullscreen) onToggleFullscreen();
        else onClose();
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      else if (e.key === 'f' || e.key === 'F') onToggleFullscreen?.();
      else return;
      onActivity();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, onClose, onActivity, fullscreen, onToggleFullscreen]);

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
          <button className="vbtn" onClick={act(onClose)} aria-label={t(lang, 'back')}>
            <Icon name="arrowLeft" size={22} />
            <span>{t(lang, 'back')}</span>
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

        <button className="vbtn" onClick={act(onClose)} aria-label={t(lang, 'close')}>
          <Icon name="x" size={24} />
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
        <div className="vw__stage" ref={stageRef}>
          <canvas className={`vw__canvas ${turning ? 'vw__canvas--turning' : ''}`} ref={canvasRef} />
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
