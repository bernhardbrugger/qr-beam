// Shared Playwright helpers: a fake "camera" that films the sender's QR canvas.
import { chromium } from 'playwright';
import { serveRoot } from './helpers.js';

export async function launch({ viewport = { width: 1100, height: 900 }, deviceScaleFactor = 1, bd = null, camSize = [640, 480] } = {}) {
  const server = await serveRoot();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, deviceScaleFactor, acceptDownloads: true });
  await context.addInitScript(installFakeCamera, { bd, camSize });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(server.url);
  return { server, browser, context, page, errors, close: async () => { await browser.close(); await server.close(); } };
}

// Runs inside the page before any page script. Replaces getUserMedia with a canvas stream and
// optionally installs a fake BarcodeDetector ('latin1' = returns raw bytes as a Latin-1 string,
// 'lossy' = returns the bytes decoded as UTF-8 like a detector that cannot do binary data).
function installFakeCamera({ bd, camSize }) {
  const cam = document.createElement('canvas');
  const [CW, CH] = camSize;
  cam.width = CW; cam.height = CH;
  const ctx = cam.getContext('2d');
  ctx.fillStyle = '#20242a'; ctx.fillRect(0, 0, CW, CH);
  window.__cam = cam;
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => cam.captureStream(30);

  // Draws an image of the sender's QR code into the camera frame like a hand-held phone would see it.
  let seedState = 1;
  const rnd = () => ((seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0) / 4294967296);
  const shoot = (src, size, blur = true) => {
    const jitter = () => (rnd() - 0.5);
    ctx.fillStyle = '#20242a'; ctx.fillRect(0, 0, CW, CH);
    ctx.save();
    ctx.translate(CW / 2 + jitter() * 8, CH / 2 + jitter() * 8);
    ctx.rotate((jitter() * 2 + 1.5) * Math.PI / 180);
    ctx.filter = blur ? 'blur(0.5px) brightness(0.93) contrast(0.95)' : 'brightness(0.93) contrast(0.95)';
    ctx.drawImage(src, -size / 2, -size / 2, size, size);
    ctx.restore();
  };
  // Same page: copy the sender's canvas, dropping a share of the frames.
  window.__pump = ({ drop = 0.15, size = Math.round(CH * 0.83), fps = 30, seed = 1 } = {}) => {
    seedState = seed >>> 0;
    const src = document.querySelector('#qr');
    window.__pumpTimer = setInterval(() => { if (rnd() >= drop) shoot(src, size); }, 1000 / fps);
  };
  // Separate sender page: a JPEG of its QR canvas (see startBridge).
  window.__present = async (b64, size = Math.round(CH * 0.83)) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob());
    shoot(bmp, size, false); bmp.close();    // JPEG + resampling already soften the image
  };
  window.__stopPump = () => clearInterval(window.__pumpTimer);

  if (bd) {
    window.BarcodeDetector = class {
      static async getSupportedFormats() { return ['qr_code']; }
      async detect(video) {
        const c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        const x = c.getContext('2d'); x.drawImage(video, 0, 0);
        const img = x.getImageData(0, 0, c.width, c.height);
        const code = window.jsQR(img.data, c.width, c.height);
        if (!code) return [];
        const bytes = Uint8Array.from(code.binaryData);
        const rawValue = bd === 'latin1' ? String.fromCharCode(...bytes) : new TextDecoder().decode(bytes);
        window.__bdCalls = (window.__bdCalls || 0) + 1;
        return [{ rawValue, format: 'qr_code', boundingBox: {}, cornerPoints: [] }];
      }
    };
  }
}

export const setSlider = (page, sel, value) =>
  page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));

export async function sendFile(page, { name = 'data.bin', mimeType = 'application/octet-stream', buffer, fps, blockSize, ecc }) {
  if (blockSize) await setSlider(page, '#bs', blockSize);
  if (fps) await setSlider(page, '#fps', fps);
  if (ecc) await page.$eval('#ecc', (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, ecc);
  await page.setInputFiles('#file', { name, mimeType, buffer: Buffer.from(buffer) });
  await page.waitForSelector('#s-state[data-state="running"]');
}

// Films the QR code on one page (sender) for another page (receiver) running in a different browser
// process: JPEG snapshots of the sender's canvas are the "camera", so sender and receiver do not share a CPU thread.
export function startBridge(senderPage, receiverPage, { fps = 30, side = 600 } = {}) {
  let on = true, frames = 0;
  const snap = (side) => {                      // runs in the sender page: downscaled JPEG of the QR canvas
    const q = document.querySelector('#qr'), t = window.__snap || (window.__snap = document.createElement('canvas'));
    t.width = t.height = side;
    const x = t.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(q, 0, 0, side, side);
    return t.toDataURL('image/jpeg', 0.85);
  };
  const loop = (async () => {
    let next = senderPage.evaluate(snap, side).catch(() => null);
    while (on) {
      const t0 = Date.now();
      const url = await next;
      next = senderPage.evaluate(snap, side).catch(() => null);          // pipeline: grab the next frame while presenting this one
      try {
        if (url) { await receiverPage.evaluate((u) => window.__present(u.slice(u.indexOf(',') + 1), 598), url); frames++; }
      } catch (e) { /* page closing */ }
      const wait = 1000 / fps - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    await next;
  })();
  return { frames: () => frames, stop: async () => { on = false; await loop; } };
}
