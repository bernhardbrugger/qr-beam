// Refreshes the inline copies of qrcode-generator and jsQR inside index.html from node_modules.
// Not needed to use qr-beam: index.html is complete as committed.
//   node scripts/vendor.mjs          write
//   node scripts/vendor.mjs --check  exit 1 if index.html differs from node_modules
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const libs = {
  qrcode: 'node_modules/qrcode-generator/dist/qrcode.js',
  jsqr: 'node_modules/jsqr/dist/jsQR.js',
};

export function inject(html) {
  let out = html;
  const stale = [];
  for (const [name, path] of Object.entries(libs)) {
    const src = readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n').trim();
    if (/<\/script/i.test(src)) throw new Error(`${path} contains "</script"`);
    const re = new RegExp(`(/\\*vendor:${name}:begin\\*/)\\n?([\\s\\S]*?)\\n?(/\\*vendor:${name}:end\\*/)`);
    const m = out.match(re);
    if (!m) throw new Error(`markers for ${name} not found in index.html`);
    if (m[2] !== src) stale.push(name);
    out = out.replace(re, (_, a, __, c) => `${a}\n${src}\n${c}`);
  }
  return { out, stale };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = join(root, 'index.html');
  const { out, stale } = inject(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  if (process.argv.includes('--check')) {
    if (stale.length) { console.error('stale vendor copies: ' + stale.join(', ')); process.exit(1); }
    console.log('vendor copies are up to date');
  } else {
    writeFileSync(file, out);
    console.log('index.html updated' + (stale.length ? ' (' + stale.join(', ') + ')' : ' (no changes)'));
  }
}
