// Loads the unpacked extension into Chrome for Testing (downloaded by
// `npm install` via puppeteer; override with CHROME_PATH) and drives the full
// flow: activation, capture, dedup, navigation, side panel edits, export.
//
// Headless Chrome can't click the toolbar button, so the side panel page is
// opened as a regular tab in the same window; it registers the same way.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';

// EXTENSION_DIR=dist/unpacked tests the packaged build (npm run test:package).
const EXTENSION_DIR = process.env.EXTENSION_DIR
  ? new URL(process.env.EXTENSION_DIR.replace(/\/?$/, '/'), `file://${process.cwd()}/`).pathname
  : new URL('../../', import.meta.url).pathname;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const html = (title, body) => `<!doctype html><title>${title}</title><body style="font:16px sans-serif;margin:40px">${body}</body>`;
const PAGES = {
  '/one': html(
    'Page One',
    `<main><article id="a1"><h1>Getting started</h1><p id="p1">Install the SDK with the command below and configure it.</p>
     <pre><code class="language-bash">npm install sdk</code></pre><img src="/img/logo.png" alt="Logo" width="50" height="50"></article>
     <p id="loose">Some other loose paragraph text to highlight.</p></main>`,
  ),
  '/two': html('Page Two', '<article id="a2"><h1>Errors</h1><p>Error codes explained here.</p></article>'),
};

let server;
let base;
let browser;
let worker;
let extId;
let docs;
let panel;
const pageErrors = [];

// --- helpers ---------------------------------------------------------------

const POLL = { polling: 100, timeout: 5000 }; // rAF polling stalls in background tabs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isActive = () => docs.evaluate(() => document.documentElement.hasAttribute('data-sm-active'));
const waitActive = (active = true) =>
  docs.waitForFunction((want) => document.documentElement.hasAttribute('data-sm-active') === want, POLL, active);
const skillState = () => worker.evaluate(() => globalThis.debugState());

/** Query inside the overlay's closed shadow root via CDP (page JS can't reach it). */
async function overlay(selector, { timeout = 3000 } = {}) {
  const client = await docs.createCDPSession();
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      const findHost = (n) =>
        n.attributes?.includes('skill-maker-host') ? n : (n.children ?? []).map(findHost).find(Boolean);
      const shadowRoot = findHost(root)?.shadowRoots?.[0];
      if (shadowRoot) {
        const { nodeId } = await client.send('DOM.querySelector', { nodeId: shadowRoot.nodeId, selector });
        if (nodeId) {
          try {
            const { model } = await client.send('DOM.getBoxModel', { nodeId }); // throws while hidden
            const [x1, y1, , , x2, y2] = model.content;
            const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId });
            return {
              click: () => docs.mouse.click((x1 + x2) / 2, (y1 + y2) / 2),
              text: outerHTML.replace(/<[^>]+>/g, ''),
            };
          } catch {
            // not rendered yet
          }
        }
      }
      await sleep(100);
    }
    throw new Error(`overlay element not visible: ${selector}`);
  } finally {
    await client.detach();
  }
}

async function altPick(selector) {
  const box = await (await docs.$(selector)).boundingBox();
  await docs.keyboard.down('Alt');
  await docs.mouse.move(box.x + 20, box.y + 5);
  await docs.mouse.move(box.x + 25, box.y + 6);
  await docs.mouse.wheel({ deltaY: -100 }); // widen to the parent container
  await docs.mouse.click(box.x + 25, box.y + 6);
  await docs.keyboard.up('Alt');
}

async function selectText(id) {
  await docs.evaluate((elId) => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById(elId));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, id);
}

async function addToSection(title) {
  await (await overlay('.bar:not([hidden]) [data-action="section"]')).click();
  await overlay('.section-form:not([hidden]) input');
  await docs.keyboard.down('Control');
  await docs.keyboard.press('a');
  await docs.keyboard.up('Control');
  await docs.keyboard.type(title);
  await docs.keyboard.press('Enter');
  await sleep(300);
}

// --- setup -----------------------------------------------------------------

before(async () => {
  server = http
    .createServer((req, res) => {
      if (req.url.startsWith('/img')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGES[req.url] ?? PAGES['/one']);
    })
    .listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    enableExtensions: [EXTENSION_DIR],
    args: ['--no-sandbox'],
  });
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('background/service-worker.js'),
  );
  worker = await swTarget.worker();
  extId = new URL(swTarget.url()).host;

  docs = (await browser.pages())[0];
  docs.on('pageerror', (e) => pageErrors.push(`page: ${e.message}`));
});

after(async () => {
  await browser?.close();
  server?.close();
});

// --- tests (sequential, sharing one browser) --------------------------------

test('pages stay untouched until the side panel opens', async () => {
  await docs.goto(`${base}/one`);
  assert.equal(await isActive(), false);

  panel = await browser.newPage();
  panel.on('pageerror', (e) => pageErrors.push(`panel: ${e.message}`));
  await panel.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  await docs.bringToFront();
  await waitActive(true);
});

test('Alt+click captures a container and marks it', async () => {
  await altPick('#p1');
  await (await overlay('.bar:not([hidden]) button.primary')).click();
  await docs.waitForFunction(() => document.getElementById('a1').hasAttribute('data-sm-captured'), POLL);

  const state = await skillState();
  const [blockId] = state.sections[0].blockIds;
  assert.match(state.blocks[blockId].content, /^# Getting started\n/);
  assert.match(state.blocks[blockId].content, /```bash\nnpm install sdk\n```/);
});

test('a highlight goes to a named section; recapturing it is flagged as a duplicate', async () => {
  await selectText('loose');
  await addToSection('Misc');
  const state = await skillState();
  assert.deepEqual(state.sections.map((s) => `${s.title}:${s.blockIds.length}`), ['Overview:1', 'Misc:1']);

  await selectText('loose');
  await (await overlay('.bar:not([hidden]) button.primary')).click();
  assert.equal((await overlay('.toast:not([hidden]) .msg')).text, 'Already captured in “Misc”.');
});

test('capturing continues after navigating to another page', async () => {
  await docs.goto(`${base}/two`);
  await waitActive(true);
  await altPick('#a2 p');
  await addToSection('Errors');
  const state = await skillState();
  assert.deepEqual(state.sections.map((s) => s.title), ['Overview', 'Misc', 'Errors']);
});

test('the side panel lists sections and supports rename and nesting', async () => {
  await panel.bringToFront();
  await panel.waitForSelector('.section[data-id="root"] .block');
  const tree = await panel.$$eval('.section', (els) =>
    els.map((e) => `${e.querySelector('.title').textContent}:${e.querySelectorAll('.block').length}`),
  );
  assert.deepEqual(tree, ['Overview:1', 'Misc:1', 'Errors:1']);
  assert.match(await panel.$eval('#stats', (e) => e.textContent), /^3 blocks · 2 sections · ~\d+ tok$/);

  const { sections } = await skillState();
  const errorsId = sections.find((s) => s.title === 'Errors').id;
  const miscId = sections.find((s) => s.title === 'Misc').id;

  await panel.click(`.section[data-id="${errorsId}"] .title`, { count: 2 });
  await panel.keyboard.down('Control');
  await panel.keyboard.press('a');
  await panel.keyboard.up('Control');
  await panel.keyboard.type('Error reference');
  await panel.keyboard.press('Enter');
  await panel.waitForFunction(
    (id) => document.querySelector(`.section[data-id="${id}"] .title`)?.textContent === 'Error reference',
    POLL,
    errorsId,
  );

  await panel.click(`.section[data-id="${errorsId}"] .section-head summary`);
  await panel.select(`.section[data-id="${errorsId}"] .section-head select`, miscId);
  await panel.waitForFunction(
    (id) => document.querySelector(`.section[data-id="${id}"]`)?.style.getPropertyValue('--depth').trim() === '1',
    POLL,
    errorsId,
  );
  assert.equal((await skillState()).sections.find((s) => s.id === errorsId).parentId, miscId);
});

test('export produces a multi-file zip with local assets', async () => {
  await panel.$eval('#skill-name', (e) => (e.value = ''));
  await panel.type('#skill-name', 'Demo SDK');
  await panel.keyboard.press('Tab'); // commit on change
  await sleep(300);

  const result = await panel.evaluate(async () => {
    const { buildZip } = await import('./exporter.js');
    const { skillMaker } = await chrome.storage.local.get('skillMaker');
    const { blob, filename, warnings } = await buildZip(skillMaker, { mode: 'multi' });
    const zip = await JSZip.loadAsync(blob);
    return {
      filename,
      warnings,
      files: Object.keys(zip.files).filter((f) => !f.endsWith('/')).sort(),
      skill: await zip.file('demo-sdk/SKILL.md').async('string'),
    };
  });
  assert.equal(result.filename, 'demo-sdk.zip');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.files, [
    'demo-sdk/SKILL.md',
    'demo-sdk/assets/logo.png',
    'demo-sdk/sections/misc.md',
    'demo-sdk/sections/misc/error-reference.md',
  ]);
  assert.match(result.skill, /^---\nname: demo-sdk\n/);
  assert.match(result.skill, /!\[Logo\]\(assets\/logo\.png\)/);
  assert.match(result.skill, /- \[Misc\]\(sections\/misc\.md\)\n {2}- \[Error reference\]\(sections\/misc\/error-reference\.md\)/);
});

test('closing the side panel deactivates capture', async () => {
  await panel.close();
  await waitActive(false);
});

test('no page or panel errors were thrown', () => {
  assert.deepEqual(pageErrors, []);
});
