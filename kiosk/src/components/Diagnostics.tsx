/**
 * On-device diagnostics.
 *
 * The panel has no developer tools and no adb in normal operation, so when a document
 * refuses to open there has to be a way to see why from the screen itself. This checks
 * the whole path a document travels — the bundled asset, the stored copy, the pdf.js
 * worker and the canvas — and reports the first thing that is actually broken.
 */
import { useState } from 'react';
import { pdfjs, PDF_OPTIONS } from '../lib/pdfEngine';
import { Icon } from './Icon';
import { loadManifest, listFileIds, getFile, metaGet } from '../lib/store';
import { checkPdf, readBundledPdf, errText } from '../lib/pdfBytes';
import { SEED_DIAG } from '../lib/seed';
import type { SeedRejection } from '../lib/seed';
import { formatBytes } from '../lib/i18n';

interface Row {
  label: string;
  value: string;
  state: 'ok' | 'warn' | 'bad' | 'info';
}

interface SeedDiagMeta {
  at?: string;
  total?: number;
  imported?: number;
  rejected?: SeedRejection[];
}

export function Diagnostics() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState('');

  const run = async () => {
    setRunning(true);
    setRows(null);
    const out: Row[] = [];
    const push = (label: string, value: string, state: Row['state'] = 'info') =>
      out.push({ label, value, state });

    // ---- environment ---------------------------------------------------------
    const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1];
    push('WebView', chrome ? `Chromium ${chrome}` : navigator.userAgent.slice(0, 60), chrome && +chrome >= 80 ? 'ok' : 'warn');
    push('Екран', `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio || 1}x`, 'info');

    // Module workers are how pdf.js runs; without them every document fails to parse.
    let workerOk = false;
    try {
      const src = URL.createObjectURL(new Blob(['self.onmessage=()=>self.postMessage(1)'], { type: 'text/javascript' }));
      const w = new Worker(src, { type: 'module' });
      workerOk = await new Promise<boolean>((res) => {
        const timer = setTimeout(() => res(false), 3000);
        w.onmessage = () => { clearTimeout(timer); res(true); };
        w.onerror = () => { clearTimeout(timer); res(false); };
        w.postMessage(0);
      });
      w.terminate();
      URL.revokeObjectURL(src);
    } catch { workerOk = false; }
    push('Module worker', workerOk ? 'поддържа се' : 'НЕ се поддържа', workerOk ? 'ok' : 'bad');

    // ---- content -------------------------------------------------------------
    const manifest = await loadManifest().catch(() => null);
    const ids = await listFileIds().catch(() => [] as string[]);
    push('Манифест', manifest ? `версия ${manifest.manifestVersion}, ${manifest.documents.length} документа` : 'липсва', manifest ? 'ok' : 'bad');
    push('Съхранени файлове', String(ids.length), ids.length ? 'ok' : 'bad');

    const seedDiag = await metaGet<SeedDiagMeta>(SEED_DIAG).catch(() => null);
    if (seedDiag) {
      const rej = seedDiag.rejected?.length ?? 0;
      push('Вграден комплект', `${seedDiag.imported ?? 0} от ${seedDiag.total ?? 0} внесени`, rej ? 'warn' : 'ok');
      for (const r of (seedDiag.rejected ?? []).slice(0, 6)) {
        push(`  отхвърлен: ${r.title.slice(0, 34)}`, r.reason, 'bad');
      }
    }

    // ---- verify every stored document ---------------------------------------
    let bad = 0;
    let firstBad = '';
    if (manifest) {
      for (const d of manifest.documents) {
        const f = await getFile(d.versionId).catch(() => undefined);
        const c = checkPdf(f?.bytes, d.sizeBytes);
        if (!c.ok) {
          bad++;
          if (!firstBad) firstBad = `${(d.titleBg || d.titleEn || d.id).slice(0, 30)}: ${f ? c.reason : 'няма файл'}`;
        }
      }
      push('Проверка на файловете', bad ? `${bad} повредени от ${manifest.documents.length}` : `всички ${manifest.documents.length} са валидни`, bad ? 'bad' : 'ok');
      if (firstBad) push('  първи проблем', firstBad, 'bad');
    }

    // ---- can we read the bundled copy at all? -------------------------------
    const sample = manifest?.documents?.[0];
    if (sample) {
      const r = await readBundledPdf(sample.versionId, sample.sizeBytes);
      push('Четене от APK', 'bytes' in r ? `ок, ${formatBytes(r.bytes.byteLength)}` : r.error, 'bytes' in r ? 'ok' : 'bad');
    }

    // ---- actually open one document end to end ------------------------------
    if (sample) {
      try {
        const f = await getFile(sample.versionId);
        let bytes = f?.bytes ?? null;
        if (!checkPdf(bytes, sample.sizeBytes).ok) {
          // Fall back to the bundled copy so the test still tells us whether pdf.js works.
          const r = await readBundledPdf(sample.versionId, sample.sizeBytes);
          bytes = 'bytes' in r ? r.bytes : null;
        }
        if (!bytes) throw new Error('няма валидни байтове за тест');
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), ...PDF_OPTIONS }).promise;
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const cv = document.createElement('canvas');
        cv.width = Math.ceil(vp.width);
        cv.height = Math.ceil(vp.height);
        const ctx = cv.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('canvas контекстът е недостъпен');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        push('Тестово отваряне', `ок — ${pdf.numPages} стр., ${Math.round(vp.width)}×${Math.round(vp.height)}`, 'ok');
        pdf.destroy();
      } catch (e) {
        push('Тестово отваряне', errText(e), 'bad');
      }
    }

    // ---- storage quota -------------------------------------------------------
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) push('Квота', `${formatBytes(est.usage || 0)} от ${formatBytes(est.quota || 0)}`, (est.usage || 0) / (est.quota || 1) > 0.9 ? 'warn' : 'ok');
    } catch { /* not available on older WebViews */ }

    setRows(out);
    setReport(out.map((r) => `${r.label}: ${r.value}`).join('\n'));
    setRunning(false);
  };

  const colour = (s: Row['state']) =>
    s === 'ok' ? 'var(--sep-ok)' : s === 'bad' ? 'var(--sep-danger)' : s === 'warn' ? 'var(--sep-warn)' : 'var(--sep-ink-muted)';

  return (
    <div className="panel">
      <h2 className="panel__t">Диагностика</h2>
      <div className="field__h" style={{ fontSize: '0.9rem', lineHeight: 1.6 }}>
        Проверява целия път на документа — вградения файл, съхраненото копие, PDF
        обработчика и изчертаването. Използвайте при проблем с отваряне на документ.
      </div>

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button className="btn btn--pri" onClick={run} disabled={running}>
          <Icon name="refresh" size={20} />
          <span>{running ? 'Проверка…' : 'Стартирай проверка'}</span>
        </button>
        {rows && (
          <button
            className="btn"
            onClick={() => navigator.clipboard?.writeText(report).catch(() => {})}
          >
            <Icon name="clipboard" size={20} />
            <span>Копирай</span>
          </button>
        )}
      </div>

      {rows && (
        <div style={{ marginTop: 16 }}>
          {rows.map((r, i) => (
            <div className="kv" key={i}>
              <span className="kv__k" style={{ whiteSpace: 'pre' }}>{r.label}</span>
              <span
                className="kv__v"
                style={{ color: colour(r.state), textAlign: 'right', wordBreak: 'break-word' }}
              >
                {r.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
