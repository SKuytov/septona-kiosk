/**
 * The one place pdf.js is configured.
 *
 * Both the viewer and the diagnostics screen need a working engine, and importing the
 * worker from two places produced a bundling warning about the worker asset being both
 * statically and dynamically imported. Everything goes through here instead.
 *
 * The worker is resolved through the bundler so it ships inside the APK — nothing is
 * ever fetched from a CDN.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs, workerUrl };

/** Options used for every document: no eval, so the engine stays CSP-safe. */
export const PDF_OPTIONS = { isEvalSupported: false } as const;
