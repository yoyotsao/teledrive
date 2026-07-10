// Bundles the `buffer` npm package into a single global IIFE script and writes
// it to public/buffer-polyfill.js. This is loaded via a classic <script> tag
// in index.html, BEFORE any ES module script — guaranteeing `window.Buffer` /
// `globalThis.Buffer` exists before GramJS's TL-schema builder runs
// `Buffer.isBuffer(...)` at module-evaluation time.
//
// Why this exists: vite-plugin-node-polyfills correctly polyfills Buffer for
// `vite dev` (esbuild pre-bundles deps), but during `vite build` (Rollup),
// deeply-nested CommonJS files under node_modules/telegram that reference the
// bare `Buffer` global are not reliably patched, causing
// "Cannot read properties of undefined (reading 'isBuffer')" at page load in
// the production build only.
//
// Run: node scripts/build-buffer-polyfill.mjs
import { build } from 'esbuild';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Written inside frontend/scripts/ (not an OS tmpdir) so esbuild's bare-import
// resolution walks up to frontend/node_modules and finds the `buffer` package.
const entryFile = join(__dirname, '_buffer-polyfill-entry.js');
writeFileSync(
  entryFile,
  "import { Buffer } from 'buffer';\n" +
  "window.Buffer = window.Buffer || Buffer;\n" +
  "globalThis.Buffer = globalThis.Buffer || Buffer;\n"
);

try {
  await build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    minify: true,
    outfile: join(__dirname, '..', 'public', 'buffer-polyfill.js'),
  });
} finally {
  unlinkSync(entryFile);
}

console.log('Wrote public/buffer-polyfill.js');
