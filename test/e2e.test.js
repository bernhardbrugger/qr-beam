import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { randomBytes } from './helpers.js';
import { launch, sendFile } from './harness.js';

const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');

// ---------------------------------------------------------------------------------------------
// 1. No camera at all: the real Send UI renders QR frames, we read the canvas back with jsQR
//    (sampling it at an unrelated rate, so frames get missed and repeated, like a camera would),
//    feed the bytes into a receiving session and compare the SHA-256 of the result.
// ---------------------------------------------------------------------------------------------
for (const [label, size] of [['empty file', 0], ['single byte', 1], ['25 kB', 25000]]) {
  test(`e2e (canvas -> jsQR): ${label} is reconstructed bit-exactly`, { timeout: 120000 }, async () => {
    const h = await launch();
    try {
      const data = randomBytes(size, size + 11);
      await sendFile(h.page, { name: `file-${size}.bin`, buffer: data, fps: 24 });
      const out = await h.page.evaluate(async () => {
        const { Core } = window.QRBeamApp, session = new Core.Session();
        const c = document.querySelector('#qr'), ctx = c.getContext('2d', { willReadFrequently: true });
        const t0 = performance.now();
        let reads = 0, misses = 0;
        while (!(session.done && session.meta) && performance.now() - t0 < 90000) {
          await new Promise((r) => setTimeout(r, 17));
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (!code) { misses++; continue; }
          reads++;
          session.push(Uint8Array.from(code.binaryData));
        }
        const v = await session.verify();
        return { ok: v.ok, level: v.level, name: session.meta && session.meta.name, bytes: Array.from(v.data), reads, misses, stats: session.stats, ms: performance.now() - t0 };
      });
      assert.ok(out.ok && out.level === 'full');
      assert.equal(out.name, `file-${size}.bin`);
      assert.equal(sha256(Uint8Array.from(out.bytes)), sha256(data));
      console.log(`  ${label}: ${out.reads} QR reads in ${(out.ms / 1000).toFixed(1)} s, stats`, JSON.stringify(out.stats));
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Fake camera: the Receive UI films the sender's canvas (rotated, blurred, 15 % of camera
//    frames dropped), finishes, and the downloaded file must equal the original.
// ---------------------------------------------------------------------------------------------
for (const bd of [null, 'latin1', 'lossy']) {
  test(`e2e (fake camera, native detector: ${bd ?? 'absent'}): UI receives and downloads the file`, { timeout: 180000 }, async () => {
    const h = await launch({ bd });
    try {
      const data = randomBytes(30000, 77);
      await sendFile(h.page, { name: 'Übung 数据.bin', mimeType: 'application/x-test', buffer: data, fps: 20 });
      await h.page.evaluate(() => window.__pump({ drop: 0.15 }));
      await h.page.click('#tab-recv');
      await h.page.click('#btn-cam');
      await h.page.waitForSelector('#result:not([hidden])', { timeout: 150000 });
      assert.match(await h.page.textContent('#res-title'), /verified/i);
      assert.equal(await h.page.textContent('#res-name'), 'Übung 数据.bin');
      const [dl] = await Promise.all([h.page.waitForEvent('download'), h.page.click('#btn-dl')]);
      assert.equal(dl.suggestedFilename(), 'Übung 数据.bin');
      const got = await readFile(await dl.path());
      assert.equal(sha256(got), sha256(data));
      const det = await h.page.evaluate(() => ({ on: window.QRBeamApp.det.on, ok: window.QRBeamApp.det.ok, calls: window.__bdCalls || 0 }));
      if (bd === 'latin1') assert.ok(det.on && det.ok > 0, 'a well-behaved native detector should be used: ' + JSON.stringify(det));
      if (bd === 'lossy') assert.ok(!det.on && det.ok === 0, 'a lossy native detector must be abandoned: ' + JSON.stringify(det));
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}

test('e2e: after Reset the receiver takes a second, different file', { timeout: 120000 }, async () => {
  const h = await launch();
  try {
    const first = randomBytes(9000, 1), second = randomBytes(4000, 2);
    await sendFile(h.page, { name: 'one.bin', buffer: first, fps: 20 });
    await h.page.evaluate(() => window.__pump({ drop: 0 }));
    await h.page.click('#tab-recv');
    await h.page.click('#btn-cam');
    await h.page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
    assert.equal(await h.page.textContent('#res-name'), 'one.bin');
    // sender switches to another file, receiver resets and films again
    await h.page.click('#tab-send');
    await h.page.setInputFiles('#file', { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from(second) });
    await h.page.click('#tab-recv');
    await h.page.click('#btn-reset');
    assert.equal(await h.page.isHidden('#result'), true);
    await h.page.click('#btn-cam');
    await h.page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
    assert.equal(await h.page.textContent('#res-name'), 'two.txt');
    const [dl] = await Promise.all([h.page.waitForEvent('download'), h.page.click('#btn-dl')]);
    assert.equal(sha256(await readFile(await dl.path())), sha256(second));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('every block size from 100 to 1500 B produces a QR that jsQR reads back (no decoder blind spots)', { timeout: 240000 }, async () => {
  const h = await launch();
  try {
    const bad = await h.page.evaluate(() => {
      const { Core, renderQR } = window.QRBeamApp, c = document.createElement('canvas');
      const sizes = [];
      for (let bs = 100; bs <= 1500; bs += 25) sizes.push(bs);
      for (let bs = 970; bs <= 1110; bs += 5) sizes.push(bs);          // includes QR version 23, which jsQR cannot read at level L
      const failures = [];
      for (const ecc of ['L', 'M']) for (const bs of sizes) {
        const payload = Uint8Array.from({ length: bs }, (_, i) => (i * 131 + bs * 7) & 255);
        const bytes = Core.packPacket({ type: 0, size: bs, blockSize: bs, k: 1, seed: bs, hash4: new Uint8Array(4), payload });
        renderQR(bytes, ecc);
        const src = document.querySelector('#qr'), ctx = c.getContext('2d', { willReadFrequently: true });
        c.width = src.width; c.height = src.height; ctx.drawImage(src, 0, 0);
        const code = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
        if (!code || code.binaryData.length !== bytes.length || code.binaryData.some((v, i) => v !== bytes[i])) failures.push(ecc + ' ' + bs);
      }
      return failures;
    });
    assert.deepEqual(bad, []);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------------------------
// 3. Page hygiene
// ---------------------------------------------------------------------------------------------
test('page loads without errors, offline-capable, and fits a phone screen', async () => {
  const h = await launch({ viewport: { width: 390, height: 844 } });
  try {
    const requests = [];
    h.page.on('request', (r) => requests.push(r.url()));
    await h.page.reload();
    for (const tab of ['#tab-send', '#tab-recv']) {
      await h.page.click(tab);
      const overflow = await h.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${tab}: horizontal overflow of ${overflow}px`);
    }
    assert.deepEqual(requests.filter((u) => !u.startsWith(h.server.url) && !u.startsWith('data:')), []);
    assert.equal(await h.page.isHidden('#cam-notice'), true, 'notice is only shown without a secure context');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
