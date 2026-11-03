import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const indexHtml = () => readFileSync(join(root, 'index.html'), 'utf8');

// Runs the <script id="..."> block of index.html and returns the value of `exportName`.
export function loadInlineScript(id, exportName) {
  const m = indexHtml().match(new RegExp(`<script id="${id}">\\n([\\s\\S]*?)\\n</script>`));
  if (!m) throw new Error(`<script id="${id}"> not found in index.html`);
  return new Function(`${m[1]}\n;return ${exportName};`)();
}
export const loadCore = () => loadInlineScript('qrbeam-core', 'QRBeamCore');

// Deterministic pseudo random bytes (so failures are reproducible).
export function randomBytes(n, seed = 1) {
  const core = loadCore(), rng = core.makeRng(seed), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng() & 255;
  return out;
}

// Tiny static server so Playwright can open the page from http://127.0.0.1 (a secure context).
export function serveRoot() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x').pathname;
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(indexHtml());
    } else { res.writeHead(404); res.end('not found'); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(r => server.close(r)) });
  }));
}
