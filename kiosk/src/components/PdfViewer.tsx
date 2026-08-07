/**
 * Offline PDF viewer built on pdf.js.
 *
 * The worker is imported through Vite so it is bundled into the APK — nothing is ever
 * fetched from a CDN. Bytes come from IndexedDB, so this works with the network cable
 * unplugged.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Icon } from './Icon';
import { getFile } from '../lib/store';
import { t, formatDate } from '../lib/i18n';
import { docTitle } from '../lib/types';
import type { Doc, Lang } from '../lib/types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type FitMode = 'width' | 'page' | 'custom';

interface Props {
  doc: Doc;
  lang: Lang;
  onClose: () => void;
  onActivity: () => void;
}

export function PdfViewer({ doc, lang, onClose, onActivity }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(doc.pageCount || 0);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState<FitMode>('width');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- load the document once -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPageNum(1);

    (async () => {
      try {
        const cached = await getFile(doc.versionId);
        if (!cached) {
          if (!cancelled) {
            setError(t(lang, 'notCached'));
            setLoading(false);
          }
          return;
        }
        // pdf.js takes ownership of the buffer, so hand it a copy.
        const data = new Uint8Array(cached.bytes.slice(0));
        const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
        if (cancelled) {
          pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        setPageCount(pdf.numPages);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError(t(lang, 'openFailed'));
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

    try {
      const page = await pdf.getPage(pageNum);
      const base = page.getViewport({ scale: 1 });

      // Fit modes are computed against the live stage size so rotation and
      // orientation changes are handled without any hard-coded panel dimensions.
      const padding = 44;
      const availW = stage.clientWidth - padding;
      const availH = stage.clientHeight - padding;
      let effective = scale;
      if (fit === 'width') effective = availW / base.width;
      else if (fit === 'page') effective = Math.min(availW / base.width, availH / base.height);

      // Cap the backing-store resolution: a 24" panel gains nothing above ~2x and
      // very large scales can exhaust WebView canvas memory.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: effective });

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, viewport.width, viewport.height);

      const task = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      await task.promise;
      renderTaskRef.current = null;
    } catch (e) {
      if ((e as Error)?.name !== 'RenderingCancelledException') {
        setError(t(lang, 'openFailed'));
      }
    }
  }, [pageNum, scale, fit, lang]);

  useEffect(() => {
    if (!loading && !error) void render();
  }, [loading, error, render]);

  // Re-render on resize so fit modes stay correct if the panel is rotated.
  useEffect(() => {
    const onResize = () => {
      if (!loading && !error) void render();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
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

  const zoom = (factor: number) => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    // Switching out of a fit mode: seed the custom scale from what is on screen.
    if (fit !== 'custom' && stage && canvas) {
      const current = canvas.clientWidth / (stage.clientWidth - 44);
      setScale(Math.max(0.25, Math.min(4, current * factor)));
    } else {
      setScale((s) => Math.max(0.25, Math.min(4, s * factor)));
    }
    setFit('custom');
  };

  // Keyboard support — handy for a wireless keyboard during setup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      else return;
      onActivity();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, onClose, onActivity]);

  return (
    <div className="vw" onPointerDown={onActivity}>
      <div className="vw__bar">
        <button className="vbtn" onClick={act(onClose)} aria-label={t(lang, 'back')}>
          <Icon name="arrowLeft" size={22} />
          <span>{t(lang, 'back')}</span>
        </button>
        <div className="vw__ttl">
          <div className="vw__t">{docTitle(doc, lang)}</div>
          <div className="vw__s">
            {t(lang, 'version')} {doc.versionNumber} · {t(lang, 'updated')}{' '}
            {formatDate(doc.updatedAt, lang)}
            {pageCount ? ` · ${pageCount} ${t(lang, 'pages')}` : ''}
          </div>
        </div>
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
            <Icon name="wifiOff" size={44} />
          </div>
          <div style={{ fontSize: '1.2rem', fontWeight: 700, textAlign: 'center', maxWidth: 620 }}>
            {error}
          </div>
          <div style={{ opacity: 0.75, textAlign: 'center', maxWidth: 540, lineHeight: 1.5 }}>
            {t(lang, 'notCachedHint')}
          </div>
        </div>
      ) : (
        <div className="vw__stage" ref={stageRef}>
          <canvas className="vw__canvas" ref={canvasRef} />
        </div>
      )}

      {!loading && !error && (
        <div className="vw__foot">
          <button className="vbtn" onClick={act(() => go(-1))} disabled={pageNum <= 1}>
            <Icon name="chevronLeft" size={22} />
            <span>{t(lang, 'prevPage')}</span>
          </button>
          <div className="vw__pg">
            {t(lang, 'page')} {pageNum} {t(lang, 'of')} {pageCount || '—'}
          </div>
          <button className="vbtn" onClick={act(() => go(1))} disabled={pageNum >= pageCount}>
            <span>{t(lang, 'nextPage')}</span>
            <Icon name="chevronRight" size={22} />
          </button>

          <div className="vw__sep" />

          <button className="vbtn" onClick={act(() => zoom(1 / 1.25))} aria-label={t(lang, 'zoomOut')}>
            <Icon name="minus" size={22} />
          </button>
          <button className="vbtn" onClick={act(() => zoom(1.25))} aria-label={t(lang, 'zoomIn')}>
            <Icon name="plus" size={22} />
          </button>
          <button
            className="vbtn"
            onClick={act(() => setFit(fit === 'width' ? 'page' : 'width'))}
          >
            <Icon name="grid" size={20} />
            <span>{fit === 'width' ? t(lang, 'fitPage') : t(lang, 'fitWidth')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
