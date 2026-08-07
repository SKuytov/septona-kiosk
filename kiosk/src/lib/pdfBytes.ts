/**
 * Reading and validating PDF byte streams.
 *
 * Why this exists: inside the APK the bundled documents are served by Capacitor's
 * WebViewLocalServer, which streams assets through an intercepted WebResourceResponse
 * that carries no Content-Length. A short or interrupted read therefore looks like a
 * perfectly ordinary successful response — `res.ok` is true and `arrayBuffer()` resolves
 * with fewer bytes than the file actually has. Storing that silently is what made the
 * board show cards whose documents could not be opened.
 *
 * So: never trust a byte stream. Every PDF is checked for its header, its trailer and
 * its expected length before it is stored or handed to pdf.js.
 */

/** Longest run of trailing bytes we scan for the end-of-file marker. */
const TRAILER_WINDOW = 2048;

const ascii = (buf: ArrayBuffer, start: number, end: number) =>
  new TextDecoder('latin1').decode(new Uint8Array(buf.slice(start, end)));

export interface PdfCheck {
  ok: boolean;
  /** Short, human-readable reason, safe to show on the maintenance screen. */
  reason?: string;
  size: number;
}

/**
 * Validate a candidate PDF.
 *
 * @param expectedSize when known (the manifest records it), an exact length match is
 *        required — this is the check that catches a truncated read.
 */
export function checkPdf(bytes: ArrayBuffer | null | undefined, expectedSize?: number): PdfCheck {
  if (!bytes) return { ok: false, reason: 'няма данни', size: 0 };
  const size = bytes.byteLength;
  if (size === 0) return { ok: false, reason: 'празен файл', size };
  // A real PDF is comfortably larger than this; anything smaller is an error page.
  if (size < 1024) return { ok: false, reason: `само ${size} B`, size };

  const head = ascii(bytes, 0, 5);
  if (head !== '%PDF-') {
    // Most likely an HTML error document served with status 200.
    const looksHtml = /^\s*(<!doctype|<html)/i.test(ascii(bytes, 0, 40));
    return { ok: false, reason: looksHtml ? 'получен е HTML вместо PDF' : `невалиден header "${head.replace(/[^\x20-\x7e]/g, '.')}"`, size };
  }

  if (typeof expectedSize === 'number' && expectedSize > 0 && size !== expectedSize) {
    return {
      ok: false,
      reason: `непълен файл: ${size} от ${expectedSize} B`,
      size,
    };
  }

  // The trailer proves the stream reached its end, which is what a truncated read loses
  // even when we have no expected size to compare against.
  const tail = ascii(bytes, Math.max(0, size - TRAILER_WINDOW), size);
  if (!tail.includes('%%EOF')) {
    return { ok: false, reason: 'липсва краен маркер (%%EOF)', size };
  }

  return { ok: true, size };
}

/**
 * Read a bundled seed document as bytes.
 *
 * `fetch` is tried first and XMLHttpRequest second: they use different code paths through
 * the Android asset interception layer, so when one returns a short body the other very
 * often succeeds. Each attempt is validated, and the first valid one wins.
 */
export async function readBundledPdf(
  versionId: string,
  expectedSize?: number,
): Promise<{ bytes: ArrayBuffer } | { error: string }> {
  const url = `./seed/${versionId}.pdf`;
  const reasons: { via: string; why: string }[] = [];

  for (let pass = 0; pass < 2; pass++) {
    const via = pass === 0 ? 'fetch' : 'xhr';
    try {
      const bytes = pass === 0 ? await viaFetch(url) : await viaXhr(url);
      const check = checkPdf(bytes, expectedSize);
      if (check.ok) return { bytes: bytes! };
      reasons.push({ via, why: check.reason ?? 'невалиден файл' });
    } catch (e) {
      reasons.push({ via, why: errText(e) });
    }
  }

  // Both readers usually fail identically; report the reason once in that case, and
  // name the reader only when they actually disagree.
  const distinct = [...new Set(reasons.map((r) => r.why))];
  return {
    error: distinct.length === 1
      ? distinct[0]
      : reasons.map((r) => `${r.via}: ${r.why}`).join('; '),
  };
}

async function viaFetch(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

function viaXhr(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      // Capacitor's asset responses report status 0 or 200 depending on the WebView.
      if (xhr.status && xhr.status !== 200) return reject(new Error(`HTTP ${xhr.status}`));
      resolve(xhr.response as ArrayBuffer);
    };
    xhr.onerror = () => reject(new Error('заявката се провали'));
    xhr.ontimeout = () => reject(new Error('изтекло време'));
    xhr.send();
  });
}

export const errText = (e: unknown): string => {
  const err = e as { name?: string; message?: string };
  const name = err?.name && err.name !== 'Error' ? err.name : '';
  const msg = err?.message || String(e);
  return [name, msg].filter(Boolean).join(': ').slice(0, 180);
};
