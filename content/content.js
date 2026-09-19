// Selection engine. Injected on demand by the service worker (never declared in
// the manifest) into the isolated world, after shared/messages.js, turndown.js
// and turndown-plugin-gfm.js. Wrapped in an IIFE so re-injection after an
// extension reload doesn't collide with the orphaned copy's declarations.
(() => {
  'use strict';

  const { MSG, STORAGE_KEY, ROOT_ID } = globalThis.SM;
  const PREFS_KEY = 'skillMakerPrefs';
  const HOST_ID = 'skill-maker-host';
  const TEARDOWN_EVENT = 'skill-maker:teardown';
  const CAPTURED_ATTR = 'data-sm-captured';

  // Elements Alt-hover can outline. Inline elements climb to the nearest of these.
  const CONTAINER_TAGS = new Set([
    'ARTICLE', 'MAIN', 'SECTION', 'ASIDE', 'NAV', 'DIV', 'PRE', 'TABLE', 'UL', 'OL', 'DL',
    'FIGURE', 'BLOCKQUOTE', 'DETAILS', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG',
  ]);
  // Page chrome that never belongs in a skill (copy buttons, icons, embeds, line numbers).
  const JUNK_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'link', 'meta', 'iframe', 'object', 'embed',
    'canvas', 'svg', 'button', 'input', 'select', 'textarea', `#${HOST_ID}`,
    '.line-numbers-rows', '.linenos', '.lineno', '.gutter',
  ].join(',');
  const ANCHOR_TEXT = /^[\s#¶§🔗]*$/u;
  const ANCHOR_CLASS = /anchor|headerlink|hash-link|permalink/i;

  // Retire an orphaned copy left behind by an extension reload (DOM events
  // cross isolated worlds, so this reaches it whichever world it lives in).
  document.dispatchEvent(new CustomEvent(TEARDOWN_EVENT));
  document.getElementById(HOST_ID)?.remove();

  const ac = new AbortController();
  const on = (target, type, fn, opts = {}) =>
    target.addEventListener(type, fn, { ...opts, signal: ac.signal });
  const isAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  let active = false;
  let skill = null; // latest state snapshot: section names + captured markers
  let prefs = { stripImages: false, convertMarkdown: true, lastSection: '' };
  let target = null; // { kind: 'range', range } | { kind: 'element', el }
  let turndown = null;
  let toastTimer = 0;
  let retry = null; // pending "Add anyway" action
  let rafPending = false;
  const hover = { base: null, depth: 0, el: null, x: -1, y: -1, wheel: 0 };

  // --- overlay UI (closed shadow root, isolated from page CSS) ---------------

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; }
    [hidden] { display: none !important; }
    .box { position: fixed; left: 0; top: 0; pointer-events: none; border-radius: 3px; }
    .hover { outline: 2px solid #6366f1; background: rgb(99 102 241 / .08); }
    .picked { outline: 2px solid #22c55e; background: rgb(34 197 94 / .08); }
    .tag { position: absolute; left: -2px; top: -22px; padding: 2px 6px; border-radius: 3px 3px 0 0;
      background: #6366f1; color: #fff; font-size: 11px; white-space: nowrap; }
    .tag.inside { top: 0; border-radius: 0 0 3px 0; }
    .bar { position: fixed; left: 0; top: 0; display: flex; flex-direction: column; gap: 6px;
      min-width: 270px; padding: 6px; border-radius: 8px; pointer-events: auto;
      background: #111827; color: #f9fafb; box-shadow: 0 6px 24px rgb(0 0 0 / .35); }
    .row { display: flex; gap: 6px; align-items: center; }
    button { cursor: pointer; padding: 5px 10px; border: 1px solid #374151; border-radius: 6px;
      background: #1f2937; color: inherit; white-space: nowrap; }
    button:hover { background: #374151; }
    button.primary { background: #4f46e5; border-color: #4f46e5; }
    button.primary:hover { background: #4338ca; }
    button:focus-visible, input:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 1px; }
    .opts { gap: 12px; padding: 0 2px; }
    .opts label { display: flex; gap: 4px; align-items: center; color: #d1d5db; font-size: 12px; cursor: pointer; }
    .opts input { margin: 0; accent-color: #6366f1; }
    .section-form { display: flex; gap: 6px; }
    .section-form input { flex: 1; min-width: 0; padding: 5px 8px; border: 1px solid #374151;
      border-radius: 6px; background: #030712; color: inherit; }
    .toast { position: fixed; right: 16px; bottom: 16px; display: flex; gap: 10px; align-items: center;
      max-width: 380px; padding: 10px 12px; border-radius: 8px; border-left: 4px solid #22c55e;
      pointer-events: auto; background: #111827; color: #f9fafb; box-shadow: 0 6px 24px rgb(0 0 0 / .35); }
    .toast.warn { border-left-color: #f59e0b; }
    .toast.error { border-left-color: #ef4444; }
  `;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>${STYLES}</style>
    <div class="box hover" hidden><span class="tag"></span></div>
    <div class="box picked" hidden></div>
    <div class="bar" role="toolbar" aria-label="Skill Maker" hidden>
      <div class="row">
        <button class="primary" data-action="add">+ Add to Skill</button>
        <button data-action="section" aria-expanded="false">Add to Section…</button>
      </div>
      <form class="section-form" hidden>
        <input name="section" list="sm-sections" placeholder="Section name" autocomplete="off"
          aria-label="Section name" required>
        <datalist id="sm-sections"></datalist>
        <button type="submit" class="primary">Add</button>
      </form>
      <div class="row opts">
        <label><input type="checkbox" name="stripImages"> Strip images</label>
        <label><input type="checkbox" name="convertMarkdown"> Convert to Markdown</label>
      </div>
    </div>
    <div class="toast" role="status" hidden>
      <span class="msg"></span><button data-action="force" hidden>Add anyway</button>
    </div>`;

  const $ = (sel) => shadow.querySelector(sel);
  const ui = {
    hover: $('.hover'),
    tag: $('.tag'),
    picked: $('.picked'),
    bar: $('.bar'),
    sectionBtn: $('[data-action="section"]'),
    form: $('.section-form'),
    input: $('.section-form input'),
    datalist: $('datalist'),
    toast: $('.toast'),
    toastMsg: $('.toast .msg'),
    forceBtn: $('[data-action="force"]'),
    strip: $('input[name="stripImages"]'),
    markdown: $('input[name="convertMarkdown"]'),
  };
  document.documentElement.append(host);

  const inUi = (e) => e.composedPath().includes(host);

  // --- activation ------------------------------------------------------------

  function setActive(next) {
    active = next;
    document.documentElement.toggleAttribute('data-sm-active', active);
    if (!active) {
      clearTarget();
      hideHover();
      hideToast();
    }
    refreshMarks();
  }

  function teardown() {
    active = false;
    ac.abort();
    host.remove();
    document.documentElement.removeAttribute('data-sm-active');
    for (const el of document.querySelectorAll(`[${CAPTURED_ATTR}]`)) el.removeAttribute(CAPTURED_ATTR);
    if (isAlive()) {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    }
    if (globalThis.__skillMaker?.isAlive === isAlive) delete globalThis.__skillMaker;
  }

  function onMessage(msg) {
    if (msg?.type === MSG.SET_ACTIVE) setActive(Boolean(msg.active));
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) {
      skill = changes[STORAGE_KEY].newValue ?? null;
      renderSectionOptions();
      refreshMarks();
    }
    if (changes[PREFS_KEY]?.newValue) {
      prefs = { ...prefs, ...changes[PREFS_KEY].newValue };
      renderPrefs();
    }
  }

  // --- page event handlers ---------------------------------------------------

  // Alt/Option + click picks a container. Runs in the window capture phase so
  // the page (and Chrome's Alt+click "download link") never sees the click.
  function onAltPointer(e) {
    if (!active || !e.altKey || e.button !== 0 || inUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    const el = hover.el ?? containerFor(asElement(e.target));
    if (!el) return;
    document.getSelection()?.removeAllRanges();
    hideHover();
    setTarget({ kind: 'element', el });
  }

  function onMouseDown(e) {
    if (active && e.button === 0 && !inUi(e)) clearTarget();
  }

  function onMouseUp(e) {
    if (active && !e.altKey && !inUi(e)) setTimeout(checkSelection, 0);
  }

  function onKeyDown(e) {
    if (!active) return;
    if (e.key === 'Alt' && hover.x >= 0) {
      updateHover(document.elementFromPoint(hover.x, hover.y));
    } else if (e.key === 'Escape') {
      clearTarget();
      hideHover();
      closeSectionForm();
    }
  }

  function onKeyUp(e) {
    if (!active || inUi(e)) return;
    if (e.key === 'Alt') return hideHover();
    if (e.shiftKey || e.ctrlKey || e.metaKey) setTimeout(checkSelection, 0); // keyboard selection
  }

  function onMouseMove(e) {
    hover.x = e.clientX;
    hover.y = e.clientY;
    if (!active) return;
    if (e.altKey && !inUi(e)) updateHover(asElement(e.target));
    else if (hover.el) hideHover();
  }

  // Alt + scroll walks the outlined container up (wider) or back down.
  function onWheel(e) {
    if (!active || !e.altKey || !hover.base) return;
    e.preventDefault();
    hover.wheel += e.deltaY;
    if (Math.abs(hover.wheel) < 40) return; // tame trackpad bursts
    if (hover.wheel < 0) {
      if (widen(hover.base, hover.depth + 1) !== hover.el) hover.depth++;
    } else if (hover.depth > 0) {
      hover.depth--;
    }
    hover.wheel = 0;
    hover.el = widen(hover.base, hover.depth);
    drawHover();
  }

  function onViewportChange() {
    if (rafPending || (!target && !hover.el)) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (hover.el) drawHover();
      renderTarget();
    });
  }

  on(window, 'mousedown', onAltPointer, { capture: true });
  on(window, 'mouseup', onAltPointer, { capture: true });
  on(window, 'click', onAltPointer, { capture: true });
  on(window, 'wheel', onWheel, { capture: true, passive: false });
  on(window, 'scroll', onViewportChange, { capture: true, passive: true });
  on(window, 'resize', onViewportChange, { passive: true });
  on(window, 'blur', hideHover);
  on(document, 'mousedown', onMouseDown);
  on(document, 'mouseup', onMouseUp);
  on(document, 'mousemove', onMouseMove, { passive: true });
  on(document, 'keydown', onKeyDown);
  on(document, 'keyup', onKeyUp);
  on(document, TEARDOWN_EVENT, teardown);

  // --- overlay event handlers ------------------------------------------------

  // Keep the page selection intact while clicking overlay controls.
  on(shadow, 'mousedown', (e) => {
    if (e.target !== ui.input) e.preventDefault();
  });
  // Stop page shortcuts (e.g. "/" to search) from firing while typing a section name.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    on(ui.bar, type, (e) => {
      if (e.key === 'Escape') closeSectionForm();
      e.stopPropagation();
    });
  }
  on(shadow, 'click', (e) => {
    const action = e.target.closest?.('[data-action]')?.dataset.action;
    if (action === 'add') capture();
    else if (action === 'section') toggleSectionForm();
    else if (action === 'force') retry?.();
  });
  on(ui.form, 'submit', (e) => {
    e.preventDefault();
    const sectionTitle = ui.input.value.trim();
    if (!sectionTitle) return;
    savePrefs({ lastSection: sectionTitle });
    capture({ sectionTitle });
  });
  on(ui.strip, 'change', () => savePrefs({ stripImages: ui.strip.checked }));
  on(ui.markdown, 'change', () => savePrefs({ convertMarkdown: ui.markdown.checked }));

  // --- selection tracking ----------------------------------------------------

  function checkSelection() {
    if (!active) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!range.toString().trim() && !range.cloneContents().querySelector('img')) return;
    setTarget({ kind: 'range', range: range.cloneRange() });
  }

  function setTarget(next) {
    target = next;
    retry = null;
    closeSectionForm();
    renderTarget();
  }

  function clearTarget() {
    target = null;
    ui.bar.hidden = true;
    ui.picked.hidden = true;
    closeSectionForm();
  }

  function targetRect() {
    return target.kind === 'element'
      ? target.el.getBoundingClientRect()
      : target.range.getBoundingClientRect();
  }

  function renderTarget() {
    if (!target) return;
    if (target.kind === 'element' && !target.el.isConnected) return clearTarget();
    const rect = targetRect();
    if (target.kind === 'element') placeBox(ui.picked, rect);
    else ui.picked.hidden = true;

    ui.bar.hidden = false;
    const { offsetWidth: w, offsetHeight: h } = ui.bar;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(rect.right - w, vw - w - 8));
    let top = rect.top - h - 8; // above the top-right corner…
    if (top < 8) top = Math.min(Math.max(8, rect.top + 8), vh - h - 8); // …or just inside it
    ui.bar.style.transform = `translate(${left}px, ${top}px)`;
  }

  function placeBox(box, rect) {
    box.hidden = false;
    box.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  // --- Alt-hover container outlining ----------------------------------------

  const asElement = (node) => (node instanceof Element ? node : node?.parentElement ?? null);

  function containerFor(el) {
    for (let cur = el; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
      if (CONTAINER_TAGS.has(cur.tagName) && !host.contains(cur)) return cur;
    }
    return null;
  }

  function widen(el, depth) {
    let cur = el;
    for (let i = 0; i < depth; i++) {
      const next = containerFor(cur.parentElement);
      if (!next) break;
      cur = next;
    }
    return cur;
  }

  function updateHover(el) {
    const base = containerFor(el);
    if (!base) return hideHover();
    if (base !== hover.base) {
      hover.base = base;
      hover.depth = 0;
      hover.wheel = 0;
    }
    hover.el = widen(base, hover.depth);
    drawHover();
  }

  function drawHover() {
    const rect = hover.el.getBoundingClientRect();
    placeBox(ui.hover, rect);
    ui.tag.textContent = `${describe(hover.el)} · Alt+scroll to resize`;
    ui.tag.classList.toggle('inside', rect.top < 24);
  }

  function hideHover() {
    hover.base = hover.el = null;
    hover.depth = hover.wheel = 0;
    ui.hover.hidden = true;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return cls ? `${tag}.${cls}` : tag;
  }

  // --- section picker & prefs -------------------------------------------------

  function toggleSectionForm() {
    if (!ui.form.hidden) return closeSectionForm();
    ui.form.hidden = false;
    ui.sectionBtn.setAttribute('aria-expanded', 'true');
    ui.input.value = prefs.lastSection ?? '';
    ui.input.focus();
    ui.input.select();
    renderTarget(); // the bar grew; keep it on screen
  }

  function closeSectionForm() {
    if (ui.form.hidden) return;
    ui.form.hidden = true;
    ui.sectionBtn.setAttribute('aria-expanded', 'false');
    renderTarget();
  }

  function renderSectionOptions() {
    ui.datalist.replaceChildren(
      ...(skill?.sections ?? []).map((s) => Object.assign(document.createElement('option'), { value: s.title })),
    );
  }

  function renderPrefs() {
    ui.strip.checked = Boolean(prefs.stripImages);
    ui.markdown.checked = prefs.convertMarkdown !== false;
  }

  function savePrefs(patch) {
    prefs = { ...prefs, ...patch };
    if (isAlive()) chrome.storage.local.set({ [PREFS_KEY]: prefs });
  }

  // --- toast -------------------------------------------------------------------

  function toast(message, kind = 'ok', onForce = null) {
    retry = onForce;
    ui.toastMsg.textContent = message;
    ui.toast.className = `toast ${kind}`;
    ui.forceBtn.hidden = !onForce;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, onForce ? 7000 : 2500);
  }

  function hideToast() {
    ui.toast.hidden = true;
    retry = null;
  }

  // --- capture -----------------------------------------------------------------

  async function capture({ sectionTitle, force = false } = {}) {
    if (!target) return;
    if (!isAlive()) return toast('Skill Maker was reloaded. Refresh this page to keep capturing.', 'error');
    if (target.kind === 'element' && !target.el.isConnected) {
      clearTarget();
      return toast('That element is no longer on the page.', 'error');
    }
    const overlap = !force && capturedOverlap(target);
    if (overlap) return toast(overlap, 'warn', () => capture({ sectionTitle, force: true }));

    const block = buildBlock(target);
    if (!block.content.trim() && !block.images.length) return toast('Nothing to capture here.', 'error');

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: MSG.OP,
        op: 'addBlock',
        payload: { sectionTitle, block, force },
      });
    } catch (err) {
      return toast(`Could not save: ${err.message}`, 'error');
    }

    if (res?.ok) {
      if (target?.kind === 'element') target.el.setAttribute(CAPTURED_ATTR, res.blockId);
      document.getSelection()?.removeAllRanges();
      clearTarget();
      toast(`Added to “${sectionTitle || sectionName(ROOT_ID)}”.`);
    } else if (res?.duplicate) {
      toast(`Already captured in “${sectionName(res.sectionId)}”.`, 'warn', () =>
        capture({ sectionTitle, force: true }),
      );
    } else {
      toast(res?.error ?? 'Could not save.', 'error');
    }
  }

  const sectionName = (id) =>
    skill?.sections.find((s) => s.id === id)?.title ?? (id === ROOT_ID ? 'Overview' : 'another section');

  function capturedOverlap(t) {
    const el = t.kind === 'element' ? t.el : asElement(t.range.commonAncestorContainer);
    if (el?.closest(`[${CAPTURED_ATTR}]`)) return 'This is inside a block you already captured.';
    if (t.kind === 'element' && el.querySelector(`[${CAPTURED_ATTR}]`)) {
      return 'This contains a block you already captured.';
    }
    return null;
  }

  /** Snapshot the target into a detached wrapper, clean it, and convert it. */
  function buildBlock(t) {
    const wrapper = document.createElement('div');
    let text;
    let selector = null;
    let originalImages = [];

    if (t.kind === 'element') {
      wrapper.append(t.el.cloneNode(true));
      text = t.el.innerText;
      selector = cssPath(t.el);
      originalImages = t.el.tagName === 'IMG' ? [t.el] : [...t.el.querySelectorAll('img')];
    } else {
      wrapper.append(t.range.cloneContents());
      text = t.range.toString();
      // A selection inside a code block loses its <pre>/<code> ancestor; restore
      // it so the result is still a (fenced) code block rather than loose text.
      const anc = asElement(t.range.commonAncestorContainer);
      const codeAncestor = anc?.closest('pre') ?? anc?.closest('code');
      if (codeAncestor) {
        const shell = codeAncestor.cloneNode(false);
        const lang = shell.nodeName === 'PRE' && codeLanguage(codeAncestor); // may live on a wrapper
        if (lang) shell.setAttribute('data-language', lang);
        shell.append(...wrapper.childNodes);
        wrapper.append(shell);
      }
    }

    clean(wrapper, originalImages);
    const images = collectImages(wrapper);
    const format = prefs.convertMarkdown !== false ? 'markdown' : 'html';
    const content = format === 'markdown' ? toMarkdown(wrapper) : wrapper.innerHTML.trim();

    return {
      format,
      content,
      text,
      images,
      selector,
      sourceUrl: pageUrl(),
      sourceTitle: document.title,
    };
  }

  function clean(root, originalImages) {
    // Pair clones with originals (same document order) before removing anything,
    // so lazy-loaded images resolve to what the browser actually displayed.
    const clonedImages = [...root.querySelectorAll('img')];
    clonedImages.forEach((img, i) => img.setAttribute('src', resolveImageSrc(img, originalImages[i])));

    for (const el of root.querySelectorAll(JUNK_SELECTOR)) el.remove();

    for (const a of root.querySelectorAll('h1 a, h2 a, h3 a, h4 a, h5 a, h6 a')) {
      if (ANCHOR_TEXT.test(a.textContent) || ANCHOR_CLASS.test(a.className)) a.remove();
    }
    for (const a of root.querySelectorAll('a[href]')) {
      if (a.href.startsWith('javascript:')) a.replaceWith(...a.childNodes);
      else a.setAttribute('href', a.href); // absolute
    }
    for (const picture of root.querySelectorAll('picture')) {
      const img = picture.querySelector('img');
      if (img) picture.replaceWith(img);
      else picture.remove();
    }
    for (const img of root.querySelectorAll('img')) {
      if (prefs.stripImages || !img.getAttribute('src')) img.remove();
      else ['srcset', 'sizes', 'loading', 'decoding'].forEach((attr) => img.removeAttribute(attr));
    }
    if (prefs.stripImages) {
      for (const fig of root.querySelectorAll('figure')) if (!fig.textContent.trim()) fig.remove();
    }
    // Highlighters often render code lines as <div>s or with <br>s, which
    // textContent would flatten onto one line.
    for (const pre of root.querySelectorAll('pre')) {
      for (const br of pre.querySelectorAll('br')) br.replaceWith('\n');
      for (const line of pre.querySelectorAll('div')) {
        if (!line.textContent.endsWith('\n')) line.append('\n');
      }
    }
  }

  function resolveImageSrc(img, original) {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    const src = original?.currentSrc || original?.src || img.src;
    if (lazy && (!src || src.startsWith('data:'))) return new URL(lazy, document.baseURI).href;
    return src;
  }

  function collectImages(root) {
    const seen = new Map();
    for (const img of root.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (!seen.has(src)) seen.set(src, { src, alt: img.getAttribute('alt') ?? '' });
    }
    return [...seen.values()];
  }

  function toMarkdown(root) {
    turndown ??= createTurndown();
    return turndown.turndown(root).trim();
  }

  function createTurndown() {
    const td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      hr: '---',
    });
    td.use(turndownPluginGfm.gfm);
    // Added last so it takes precedence: handles <pre> with or without <code>,
    // detects the language from common highlighter conventions, and picks a
    // fence longer than any backtick run inside the code.
    td.addRule('fencedPre', {
      filter: (node) => node.nodeName === 'PRE',
      replacement(_content, node) {
        const code = node.textContent.replace(/\n+$/, '');
        const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
        const fence = '`'.repeat(Math.max(3, longest + 1));
        return `\n\n${fence}${codeLanguage(node)}\n${code}\n${fence}\n\n`;
      },
    });
    // Turndown pads markers to 4 columns ("-   item"); use the conventional
    // "- item" / "1. item" and indent continuation lines to match.
    td.addRule('compactListItem', {
      filter: 'li',
      replacement(content, node, options) {
        const parent = node.parentNode;
        let prefix = `${options.bulletListMarker} `;
        if (parent.nodeName === 'OL') {
          const start = Number(parent.getAttribute('start') ?? 1);
          prefix = `${start + [...parent.children].indexOf(node)}. `;
        }
        const body = content
          .replace(/^\n+/, '')
          .replace(/\n+$/, '\n')
          .replace(/\n/gm, `\n${' '.repeat(prefix.length)}`);
        return prefix + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '');
      },
    });
    return td;
  }

  function codeLanguage(pre) {
    const candidates = [pre.querySelector('code'), pre, pre.parentElement, pre.parentElement?.parentElement];
    for (const el of candidates) {
      if (!el) continue;
      const attr = el.getAttribute('data-language') || el.getAttribute('data-lang');
      if (attr) return attr.toLowerCase();
      const cls = typeof el.className === 'string' ? el.className : '';
      const match = cls.match(/(?:^|\s)(?:language|lang|highlight-source|highlight)-([\w+#-]+)/);
      if (match) return match[1].toLowerCase();
    }
    return '';
  }

  // --- captured-element markers ----------------------------------------------

  const pageUrl = () => location.href.split('#')[0];

  function cssPath(el) {
    const parts = [];
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const tag = cur.tagName.toLowerCase();
      const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    }
    return parts.join(' > ');
  }

  /** Re-mark elements on this page that are already in the skill. */
  function refreshMarks() {
    for (const el of document.querySelectorAll(`[${CAPTURED_ATTR}]`)) el.removeAttribute(CAPTURED_ATTR);
    if (!active || !skill) return;
    const here = pageUrl();
    for (const block of Object.values(skill.blocks)) {
      if (!block.selector || block.source.url !== here) continue;
      try {
        document.querySelector(block.selector)?.setAttribute(CAPTURED_ATTR, block.id);
      } catch {
        // stale or invalid selector — skip
      }
    }
  }

  // --- boot --------------------------------------------------------------------

  globalThis.__skillMaker = { isAlive };
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  renderPrefs();
  chrome.storage.local.get([STORAGE_KEY, PREFS_KEY]).then((stored) => {
    skill = stored[STORAGE_KEY] ?? null;
    prefs = { ...prefs, ...stored[PREFS_KEY] };
    renderPrefs();
    renderSectionOptions();
    refreshMarks();
  });
})();
