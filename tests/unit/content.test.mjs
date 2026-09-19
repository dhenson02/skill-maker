import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadContentPage } from '../helpers/content-page.mjs';

const DOC = `
<main id="main">
  <article id="art">
    <h2 id="install">Install <a class="headerlink" href="#install">¶</a></h2>
    <p id="intro">Run the <code>npm</code> command. See <a href="/guide">guide</a>.</p>
    <div class="language-js"><pre class="shiki"><code><span class="line">const a = 1;</span>
<span class="line">console.log(\`\${a}\`);</span></code></pre><button>Copy</button></div>
    <table><thead><tr><th>Opt</th><th>Desc</th></tr></thead><tbody><tr><td>x</td><td>does x</td></tr></tbody></table>
    <ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>
    <ol start="3"><li>three</li><li>four</li></ol>
    <img data-src="/img/diagram.png" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Diagram">
    <svg><path/></svg>
  </article>
</main>
<p id="outside">Loose paragraph outside the article.</p>`;

async function captureArticle(opts) {
  const page = await loadContentPage(DOC, opts);
  const art = page.document.getElementById('art');
  await page.altPick(art.querySelector('p'), 1); // p -> widen once -> article
  await page.clickUi('[data-action="add"]');
  return { page, art, block: page.lastBlock() };
}

describe('container selection (Alt+click)', () => {
  test('hover outline widens with Alt+scroll and the click is swallowed', async () => {
    const page = await loadContentPage(DOC);
    const p = page.document.getElementById('intro');
    page.mouse(p, 'mousemove', { altKey: true });
    assert.match(page.ui('.tag').textContent, /^p\b/);
    page.window.dispatchEvent(new page.window.WheelEvent('wheel', { deltaY: -100, altKey: true, cancelable: true }));
    assert.match(page.ui('.tag').textContent, /^article#art/);
    const { defaultPrevented } = await page.altPick(p, 0);
    assert.equal(defaultPrevented, true, 'Alt+click must not reach the page (e.g. link download)');
    assert.equal(page.ui('.bar').hidden, false);
  });

  test('sends a Markdown block with source metadata and a stable selector', async () => {
    const { page, block } = await captureArticle();
    const msg = page.sent[0];
    assert.equal(msg.type, 'sm:op');
    assert.equal(msg.op, 'addBlock');
    assert.equal(msg.payload.sectionTitle, undefined, '"Add to Skill" targets root');
    assert.equal(block.format, 'markdown');
    assert.equal(block.selector, '#art');
    assert.equal(block.sourceUrl, 'https://docs.example.com/start', 'hash is dropped');
    assert.equal(block.sourceTitle, 'Docs Page');
  });

  test('converts headings, links, code, tables and lists; drops page chrome', async () => {
    const { block } = await captureArticle();
    const md = block.content;
    assert.match(md, /^## Install$/m);
    assert.doesNotMatch(md, /¶|headerlink/, 'heading permalink removed');
    assert.match(md, /\[guide\]\(https:\/\/docs\.example\.com\/guide\)/, 'links made absolute');
    assert.match(md, /```js\nconst a = 1;\nconsole\.log\(`\$\{a\}`\);\n```/, 'fenced with language from wrapper');
    assert.doesNotMatch(md, /Copy/, 'copy button removed');
    assert.match(md, /\| Opt \| Desc \|\n\| --- \| --- \|\n\| x \| does x \|/);
    assert.match(md, /^- one\n {2}- nested\n- two$/m, 'compact bullets with nesting');
    assert.match(md, /^3\. three\n4\. four$/m, 'ordered list honors start');
  });

  test('resolves lazy images to absolute URLs and reports them', async () => {
    const { block } = await captureArticle();
    assert.deepEqual(block.images, [{ src: 'https://docs.example.com/img/diagram.png', alt: 'Diagram' }]);
    assert.match(block.content, /!\[Diagram\]\(https:\/\/docs\.example\.com\/img\/diagram\.png\)/);
  });

  test('marks the captured element', async () => {
    const { art } = await captureArticle();
    assert.equal(art.getAttribute('data-sm-captured'), 'b1');
  });
});

describe('capture options', () => {
  test('"Strip images" removes images', async () => {
    const { block } = await captureArticle({ prefs: { stripImages: true } });
    assert.deepEqual(block.images, []);
    assert.doesNotMatch(block.content, /!\[/);
  });

  test('"Convert to Markdown" off stores cleaned HTML', async () => {
    const { block } = await captureArticle({ prefs: { convertMarkdown: false } });
    assert.equal(block.format, 'html');
    assert.match(block.content, /^<article id="art">/);
    assert.doesNotMatch(block.content, /<button|<svg/);
  });
});

describe('text selection', () => {
  test('a selection inside a code block stays a fenced block with its language', async () => {
    const page = await loadContentPage(DOC);
    const code = page.document.querySelector('pre code');
    await page.select(code.firstChild.firstChild, 0, code.lastChild.firstChild, 5);
    assert.equal(page.ui('.bar').hidden, false);
    await page.addToSection('Examples');
    assert.equal(page.sent.at(-1).payload.sectionTitle, 'Examples');
    assert.equal(page.lastBlock().content, '```js\nconst a = 1;\nconso\n```');
    assert.equal(page.lastBlock().selector, null);
  });

  test('collapsed selections do not show the overlay', async () => {
    const page = await loadContentPage(DOC);
    const text = page.document.getElementById('outside').firstChild;
    await page.select(text, 3, text, 3);
    assert.equal(page.ui('.bar').hidden, true);
  });
});

describe('deduplication', () => {
  test('warns before capturing inside an already captured container, then allows forcing', async () => {
    const { page, art } = await captureArticle();
    await page.altPick(art.querySelector('ul'));
    await page.clickUi('[data-action="add"]');
    assert.match(page.toastText(), /inside a block you already captured/);
    assert.equal(page.sent.length, 1, 'nothing sent before confirming');

    await page.clickUi('[data-action="force"]');
    assert.equal(page.sent.length, 2);
    assert.equal(page.sent[1].payload.force, true);
  });

  test('warns when the container contains a captured block', async () => {
    const { page } = await captureArticle();
    await page.altPick(page.document.getElementById('main'));
    await page.clickUi('[data-action="add"]');
    assert.match(page.toastText(), /contains a block you already captured/);
  });

  test('surfaces duplicate responses from the service worker with "Add anyway"', async () => {
    const page = await loadContentPage(DOC, {
      reply: (_msg, n) => (n === 1 ? { ok: false, duplicate: true, blockId: 'b0', sectionId: 'root' } : { ok: true }),
    });
    await page.altPick(page.document.getElementById('outside'));
    await page.clickUi('[data-action="add"]');
    assert.match(page.toastText(), /Already captured in “Overview”/);
    assert.equal(page.ui('[data-action="force"]').hidden, false);
  });
});

describe('lifecycle', () => {
  test('re-injection retires the previous instance', async () => {
    const page = await loadContentPage(DOC);
    const hosts = () => page.document.querySelectorAll('#skill-maker-host').length;
    assert.equal(hosts(), 1);
    page.document.dispatchEvent(new page.window.CustomEvent('skill-maker:teardown'));
    assert.equal(hosts(), 0);
    assert.equal(page.window.eval('globalThis.__skillMaker'), undefined);
  });

  test('deactivation hides the overlay and ignores Alt+click', async () => {
    const page = await loadContentPage(DOC);
    const intro = page.document.getElementById('intro');
    await page.altPick(intro);
    assert.equal(page.ui('.bar').hidden, false);
    assert.equal(page.document.documentElement.hasAttribute('data-sm-active'), true);

    page.setActive(false);
    assert.equal(page.ui('.bar').hidden, true);
    assert.equal(page.document.documentElement.hasAttribute('data-sm-active'), false);
    const { defaultPrevented } = await page.altPick(intro);
    assert.equal(defaultPrevented, false, 'inactive pages keep native Alt+click');
    assert.equal(page.ui('.bar').hidden, true);
  });
});
