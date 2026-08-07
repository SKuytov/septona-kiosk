/**
 * Post-build step: list every emitted asset so the service worker can precache the
 * exact shell for this build. Hashed filenames cannot be hard-coded in sw.js.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const out = [];

const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else {
      const rel = relative(dist, full).split('\\').join('/');
      if (rel === 'sw.js' || rel === 'sw-assets.json') continue;
      out.push('./' + rel);
    }
  }
};

walk(dist);
writeFileSync(join(dist, 'sw-assets.json'), JSON.stringify(out));
console.log(`sw-assets.json: ${out.length} shell assets precached`);
