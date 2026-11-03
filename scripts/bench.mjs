// Measures end-to-end goodput of the real UI with sender and receiver in two separate browser processes:
//   sender page (real UI, real QR canvas) --screenshots as a 30 fps "camera"--> receiver page (real UI,
//   fake camera stream 1280x720, QR code filling 83 % of the height, slight rotation + blur + JPEG).
// This is a simulation in headless Chromium on one PC, not a phone measurement. See README.
//   npm run bench            (about 3 minutes)
import { launch, sendFile, startBridge } from '../test/harness.js';
import { randomBytes } from '../test/helpers.js';

const FILE_BYTES = 60000;
const cases = [
  { blockSize: 300, fps: 12, ecc: 'L' },
  { blockSize: 600, fps: 6, ecc: 'L' },
  { blockSize: 600, fps: 12, ecc: 'L' },
  { blockSize: 600, fps: 12, ecc: 'M' },
  { blockSize: 600, fps: 20, ecc: 'L' },
  { blockSize: 1000, fps: 12, ecc: 'L' },
  { blockSize: 1500, fps: 10, ecc: 'L' },
];

const rows = [];
for (const c of cases) {
  const sender = await launch({ viewport: { width: 1000, height: 1100 } });
  const receiver = await launch({ camSize: [1280, 720] });
  try {
    const data = randomBytes(FILE_BYTES, c.blockSize * 31 + c.fps);
    await sendFile(sender.page, { buffer: data, ...c });
    const qrVersion = await sender.page.evaluate(() => /v(\d+)/.exec(document.querySelector('#s-kind').textContent)?.[1]);
    await receiver.page.click('#tab-recv');
    await receiver.page.click('#btn-cam');
    const bridge = startBridge(sender.page, receiver.page, { fps: 30 });
    const t0 = Date.now();
    let secs = null;
    try {
      await receiver.page.waitForSelector('#result:not([hidden])', { timeout: 150000 });
      secs = (Date.now() - t0) / 1000;
    } catch (e) { /* timeout: reported below */ }
    const st = await receiver.page.evaluate(() => {
      const { R } = window.QRBeamApp, d = R.session.decoder;
      return { k: d && d.k, packets: d && d.received, ok: !!(R.result && R.result.ok), scanMs: R.scanMs / Math.max(1, R.scans) };
    });
    await bridge.stop();
    rows.push({
      ...c, qrVersion, seconds: secs ? secs.toFixed(1) : 'timeout',
      goodputKBs: secs ? (FILE_BYTES / secs / 1000).toFixed(2) : '-',
      rawKBs: (c.blockSize * c.fps / 1000).toFixed(1),
      packets: st.packets, k: st.k, verified: st.ok, decodeMs: st.scanMs.toFixed(0), camFrames: bridge.frames(),
    });
    console.log('done', JSON.stringify(rows.at(-1)));
  } finally { await sender.close(); await receiver.close(); }
}
console.table(rows);
console.log('\n| block | fps | ECC | QR version | raw KB/s | measured goodput KB/s | time for 60 KB | decode ms/frame |\n|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.blockSize} B | ${r.fps} | ${r.ecc} | ${r.qrVersion} | ${r.rawKBs} | ${r.goodputKBs} | ${r.seconds} s | ${r.decodeMs} |`);
