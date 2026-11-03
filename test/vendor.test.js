import test from 'node:test';
import assert from 'node:assert/strict';
import { inject } from '../scripts/vendor.mjs';
import { indexHtml } from './helpers.js';

test('inline copies of qrcode-generator and jsQR match node_modules', () => {
  const { stale } = inject(indexHtml());
  assert.deepEqual(stale, []);
});

test('index.html is self-contained (no external script, style, font or image URLs)', () => {
  const html = indexHtml().replace(/<script id="vendor-[\s\S]*?<\/script>/g, '');
  assert.equal(/<(script|link|img|iframe)[^>]+(src|href)=["']?https?:/i.test(html), false);
  assert.equal(/url\(\s*["']?https?:/i.test(html), false);
  assert.equal(/@import/i.test(html), false);
});
