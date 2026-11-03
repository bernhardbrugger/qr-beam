// Renders both modes with Playwright (fake camera filming the sender) and saves screenshots to docs/.
//   npm run screenshots
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sendFile } from '../test/harness.js';
import { randomBytes, root } from '../test/helpers.js';

const out = join(root, 'docs');
mkdirSync(out, { recursive: true });
const shot = (page, name, opts = {}) => page.screenshot({ path: join(out, name), type: 'jpeg', quality: 82, ...opts });

async function run({ label, viewport, scale }) {
  const h = await launch({ viewport, deviceScaleFactor: scale });
  const { page } = h;
  await page.waitForTimeout(900);                                   // let the entrance animation settle
  await shot(page, `${label}-send-empty.jpg`);

  await sendFile(page, { name: 'quarterly-report.pdf', mimeType: 'application/pdf', buffer: randomBytes(48000, 3), fps: 12 });
  await page.waitForTimeout(500);
  await shot(page, `${label}-send-running.jpg`);

  await page.evaluate(() => window.__pump({ drop: 0.2 }));
  await page.click('#tab-recv');
  await page.waitForTimeout(700);
  await shot(page, `${label}-receive-idle.jpg`);

  await page.click('#btn-cam');
  await page.waitForFunction(() => {
    const d = window.QRBeamApp.R.session.decoder;
    return d && d.received >= d.k * 0.55;
  }, null, { timeout: 120000 });
  await shot(page, `${label}-receive-progress.jpg`);

  await page.waitForSelector('#result:not([hidden])', { timeout: 120000 });
  await page.waitForTimeout(700);
  await shot(page, `${label}-receive-done.jpg`, { fullPage: true });
  console.log(label, 'ok', h.errors.length ? h.errors : '');
  await h.close();
}

await run({ label: 'desktop', viewport: { width: 1100, height: 900 }, scale: 1 });
await run({ label: 'mobile', viewport: { width: 390, height: 844 }, scale: 2 });
