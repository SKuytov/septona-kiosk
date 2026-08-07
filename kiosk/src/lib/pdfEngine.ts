/**
 * The one place pdf.js is configured.
 *
 * Both the viewer and the diagnostics screen need a working engine, and importing the
 * worker from two places produced a bundling warning about the worker asset being both
 * statically and dynamically imported. Everything goes through here instead.
 *
 * The worker is resolved through the bundler so it ships inside the APK — nothing is ever
 * fetched from a CDN.
 *
 * ## Why the legacy build
 *
 * The default pdf.js build targets current browsers and calls `Promise.withResolvers()`
 * directly, an API added in Chrome/WebView 119. On panels with an older System WebView
 * every document failed with `TypeError: Promise.withResolvers is not a function` — the
 * board rendered, the bytes were perfect, and the engine died the moment it was handed a
 * file. Industrial displays cannot be assumed to have a current WebView, and their
 * firmware often cannot be updated at all.
 *
 * The `legacy` build exists for exactly this case: it is transpiled further and bundles
 * core-js polyfills for the newer APIs, in the worker bundle as well as the main one,
 * which matters because the worker is a separate realm that main-thread shims cannot
 * reach. `src/lib/compat.ts` covers the app's own code; this covers the engine.
 *
 * The cost is a modestly larger bundle. That is the right trade for a display that has to
 * work on hardware chosen by a facilities department, not by us.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs, workerUrl };

/** Options used for every document: no eval, so the engine stays CSP-safe. */
export const PDF_OPTIONS = { isEvalSupported: false } as const;

/** Reported by the diagnostics screen, so the shipped engine build is never in doubt. */
export const PDF_BUILD = `${pdfjs.version} legacy`;
