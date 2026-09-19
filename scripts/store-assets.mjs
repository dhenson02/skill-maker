// Renders extension icons and Chrome Web Store listing images with headless
// Chrome (puppeteer; set CHROME_PATH to use an existing binary).
//
//   node scripts/store-assets.mjs icons   -> icons/icon-{16,32,48,128}.png
//   node scripts/store-assets.mjs store   -> store/screenshot-*.png, store/promo-small.png
//   node scripts/store-assets.mjs         -> both
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import puppeteer from 'puppeteer';
import { DEMO_PAGE, demoState } from './store-demo.mjs';

const ROOT = new URL('../', import.meta.url);
const path = (p) => new URL(p, ROOT).pathname;
const what = process.argv[2] ?? 'all';

// The demo docs are served locally but shown under a reserved example domain,
// so screenshots don't show 127.0.0.1 and a random port.
const DEMO_ORIGIN = 'http://docs.nimbus.example';
const server = http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(DEMO_PAGE);
  })
  .listen(0);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  enableExtensions: what === 'icons' ? false : [path('.')],
  args: [
    '--no-sandbox',
    `--host-resolver-rules=MAP docs.nimbus.example:80 127.0.0.1:${server.address().port}`,
  ],
});

try {
  if (what === 'icons' || what === 'all') await renderIcons();
  if (what === 'store' || what === 'all') await renderStoreImages();
} finally {
  await browser.close();
  server.close();
}

// --- icons -------------------------------------------------------------------

async function renderIcons() {
  const svg = await readFile(path('icons/icon.svg'), 'utf8');
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    // Store icon keeps its transparent padding; toolbar sizes use the full canvas.
    const viewBox = size === 128 ? '0 0 128 128' : '16 16 96 96';
    const sized = svg.replace(/viewBox="[^"]+"/, `viewBox="${viewBox}" width="${size}" height="${size}"`);
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
    await page.screenshot({ path: path(`icons/icon-${size}.png`), omitBackground: true });
    console.log(`icons/icon-${size}.png`);
  }
  await page.close();
}

// --- store images ------------------------------------------------------------

async function renderStoreImages() {
  const base = DEMO_ORIGIN;
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('background/service-worker.js'),
  );
  const worker = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  await worker.evaluate((state) => chrome.storage.local.set({ skillMaker: state }), demoState(base));

  const docs = (await browser.pages())[0];
  await docs.setViewport({ width: 880, height: 800 });
  await docs.goto(`${base}/docs/authentication`);

  const panel = await browser.newPage();
  await panel.setViewport({ width: 400, height: 830 }); // 830 * 0.85 ≈ frame height
  await panel.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  await panel.waitForSelector('.block');
  await docs.bringToFront();
  await docs.waitForFunction(() => document.documentElement.hasAttribute('data-sm-active'), { polling: 100 });

  // 1. Picking a container on the page.
  const target = await (await docs.$('#rate-limits p')).boundingBox();
  await docs.keyboard.down('Alt');
  await docs.mouse.move(target.x + 30, target.y + 8);
  await docs.mouse.wheel({ deltaY: -100 }); // widen to the whole section
  await docs.mouse.click(target.x + 30, target.y + 8);
  await docs.keyboard.up('Alt');
  await sleep(300);
  const capturePage = await docs.screenshot();
  await panel.bringToFront(); // headless can only screenshot the front tab
  await compose('store/screenshot-1-capture.png', capturePage, await panel.screenshot(), {
    title: 'Capture docs as you browse',
    subtitle: 'Highlight text or Alt+click a whole section, then add it to your skill.',
  });

  // 2. Organizing + exporting.
  await panel.click('input[name="mode"][value="multi"]');
  await panel.click('#preview');
  await panel.waitForSelector('dialog[open]');
  const exportPanel = await panel.screenshot();
  await docs.bringToFront();
  await compose('store/screenshot-2-export.png', await docs.screenshot(), exportPanel, {
    title: 'Export a ready-to-use skill',
    subtitle: 'One SKILL.md, or an index plus section files, with images bundled.',
  });

  await promoTile();
}

/** 1280x800: caption strip + page on the left + side panel on the right. */
async function compose(out, pagePng, panelPng, { title, subtitle }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const img = (buf) => `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
  await page.setContent(`
    <style>
      * { box-sizing: border-box; margin: 0; }
      body { width: 1280px; height: 800px; overflow: hidden; font-family: system-ui, sans-serif;
        background: linear-gradient(135deg, #eef2ff, #e0e7ff); }
      header { height: 96px; padding: 22px 40px; }
      h1 { font-size: 28px; color: #1e1b4b; }
      p { margin-top: 4px; font-size: 16px; color: #4338ca; }
      .frame { position: absolute; left: 40px; right: 40px; top: 96px; bottom: 0; display: flex;
        border-radius: 12px 12px 0 0; overflow: hidden; box-shadow: 0 10px 40px rgb(30 27 75 / .25); background: #fff; }
      .frame img { display: block; object-fit: cover; object-position: top left; }
      .page { flex: 1; min-width: 0; }
      .page img { width: 880px; }
      .panel { width: 340px; border-left: 1px solid #d4d4d8; }
      .panel img { width: 400px; transform-origin: top left; transform: scale(.85); }
    </style>
    <header><h1>${title}</h1><p>${subtitle}</p></header>
    <div class="frame">
      <div class="page"><img src="${img(pagePng)}"></div>
      <div class="panel"><img src="${img(panelPng)}"></div>
    </div>`);
  await page.screenshot({ path: path(out) });
  await page.close();
  console.log(out);
}

/** 440x280 small promo tile (required by the store). */
async function promoTile() {
  const svg = await readFile(path('icons/icon.svg'), 'utf8');
  const page = await browser.newPage();
  await page.setViewport({ width: 440, height: 280, deviceScaleFactor: 1 });
  await page.setContent(`
    <style>
      * { margin: 0; }
      body { width: 440px; height: 280px; display: flex; align-items: center; gap: 20px; padding: 0 36px;
        box-sizing: border-box; font-family: system-ui, sans-serif; color: #fff;
        background: radial-gradient(circle at 20% 20%, #6366f1, #312e81); }
      svg { width: 120px; height: 120px; flex: none; }
      h1 { font-size: 34px; letter-spacing: -.5px; }
      p { margin-top: 8px; font-size: 16px; line-height: 1.35; color: #e0e7ff; }
    </style>
    ${svg.replace(/viewBox="[^"]+"/, 'viewBox="12 12 104 104"')}
    <div><h1>Skill Maker</h1><p>Turn web docs into Markdown skills for LLMs.</p></div>`);
  await page.screenshot({ path: path('store/promo-small.png') });
  await page.close();
  console.log('store/promo-small.png');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
