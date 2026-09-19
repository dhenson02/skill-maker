// Skill Manager. Renders the section tree from chrome.storage.local and sends
// every change to the service worker (the only writer; see background/store.js).

import { blockTitle, buildFiles, buildZip, orderedSections } from './exporter.js';

const { MSG, PORT_PREFIX, STORAGE_KEY, ROOT_ID } = globalThis.SM;
const EXPORT_PREFS_KEY = 'skillMaker.exportPrefs'; // localStorage: per-panel UI preference
const LARGE_SECTION_CHARS = 20_000;
const KEEPALIVE_MS = 20_000;

const $ = (id) => document.getElementById(id);
const els = {
  name: $('skill-name'),
  desc: $('skill-desc'),
  stats: $('stats'),
  tree: $('tree'),
  emptyTemplate: $('empty-template'),
  images: $('opt-images'),
  sources: $('opt-sources'),
  clear: $('clear'),
  preview: $('preview'),
  exportBtn: $('export'),
  status: $('status'),
  dialog: $('preview-dialog'),
  previewFile: $('preview-file'),
  previewBody: $('preview-body'),
  previewClose: $('preview-close'),
};

let state = null;
let renderPending = false;
let editingBlockId = null;
let pendingRenameId = null;
let drag = null; // { kind: 'block' | 'section', id }
let dropHint = null; // { el, cls }
const collapsed = new Set();

// --- plumbing ------------------------------------------------------------------

/** Keep a port open so the service worker knows this window's panel is open. */
async function connect() {
  const { id: windowId } = await chrome.windows.getCurrent();
  const open = () => {
    const port = chrome.runtime.connect({ name: PORT_PREFIX + windowId });
    const timer = setInterval(() => port.postMessage({ type: MSG.PING }), KEEPALIVE_MS);
    port.onDisconnect.addListener(() => {
      clearInterval(timer);
      setTimeout(open, 500); // worker restarted; re-register
    });
  };
  open();
}

async function op(name, payload = {}) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: MSG.OP, op: name, payload });
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  if (!res?.ok) setStatus(res?.error ?? 'Something went wrong.', 'error');
  return res;
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

/** Tiny DOM builder. Props: class, dataset, style, on<event>, value, or attributes. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (val == null || val === false) continue;
    if (key === 'class') el.className = val;
    else if (key === 'dataset') Object.assign(el.dataset, val);
    else if (key === 'style') el.style.cssText = val;
    else if (key === 'value') continue; // set after children (textarea/select)
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), val);
    else el.setAttribute(key, val === true ? '' : val);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  if (props.value != null) el.value = props.value;
  return el;
}

const sectionById = (id) => state?.sections.find((s) => s.id === id);
const sectionOfBlock = (blockId) => state?.sections.find((s) => s.blockIds.includes(blockId));
const parentKey = (section) => (section.parentId && sectionById(section.parentId) ? section.parentId : null);

function isDescendant(candidateId, ancestorId) {
  for (let s = sectionById(candidateId); s; s = sectionById(s.parentId)) {
    if (s.id === ancestorId) return true;
  }
  return false;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

const formatTokens = (chars) => {
  const tokens = Math.round(chars / 4); // rough heuristic
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k tok` : `~${tokens} tok`;
};

// --- rendering -----------------------------------------------------------------

/** Don't rebuild the tree under the user's cursor while they type. */
function isInteracting() {
  const active = document.activeElement;
  return Boolean(active?.closest('#tree') && active.matches('input, textarea, select'));
}

function render() {
  if (isInteracting()) {
    renderPending = true;
    return;
  }
  renderPending = false;
  renderMeta();
  renderTree();
  if (pendingRenameId && sectionById(pendingRenameId)) {
    const id = pendingRenameId;
    pendingRenameId = null;
    startRename(id);
  }
}

function renderMeta() {
  const meta = state?.meta ?? { name: '', description: '' };
  if (document.activeElement !== els.name) els.name.value = meta.name;
  if (document.activeElement !== els.desc) els.desc.value = meta.description;

  const blocks = Object.values(state?.blocks ?? {});
  const chars = blocks.reduce((n, b) => n + b.content.length, 0);
  const sections = (state?.sections.length ?? 1) - 1;
  els.stats.textContent = blocks.length
    ? `${blocks.length} block${blocks.length === 1 ? '' : 's'} · ${sections} section${sections === 1 ? '' : 's'} · ${formatTokens(chars)}`
    : '';
}

function renderTree() {
  const blockCount = Object.keys(state?.blocks ?? {}).length;
  if (!state || (blockCount === 0 && state.sections.length <= 1)) {
    els.tree.replaceChildren(els.emptyTemplate.content.cloneNode(true));
    return;
  }
  const scroll = els.tree.scrollTop;
  const entries = orderedSections(state);
  els.tree.replaceChildren(...entries.map((entry) => renderSection(entry, entries)));
  els.tree.scrollTop = scroll;
}

function renderSection({ section, depth }, entries) {
  const isRoot = section.id === ROOT_ID;
  const isCollapsed = collapsed.has(section.id);
  const blocks = section.blockIds.map((id) => state.blocks[id]).filter(Boolean);
  const chars = blocks.reduce((n, b) => n + b.content.length, 0);
  const large = chars > LARGE_SECTION_CHARS;

  const head = h(
    'header',
    { class: 'section-head', draggable: isRoot ? null : 'true' },
    h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
    h('button', {
      class: 'icon twisty',
      type: 'button',
      'aria-label': isCollapsed ? 'Expand section' : 'Collapse section',
      'aria-expanded': String(!isCollapsed),
      onclick: () => {
        if (isCollapsed) collapsed.delete(section.id);
        else collapsed.add(section.id);
        render();
      },
    }),
    h(
      'span',
      {
        class: 'title',
        title: isRoot ? 'Body of SKILL.md. Double-click to rename.' : 'Double-click to rename',
        ondblclick: () => startRename(section.id),
      },
      section.title,
    ),
    h(
      'span',
      {
        class: `count${large ? ' large' : ''}`,
        title: large ? 'Large section: consider splitting it into sub-files' : null,
      },
      `${blocks.length} · ${formatTokens(chars)}`,
    ),
    sectionMenu(section, entries),
  );

  const list = h(
    'ol',
    { class: 'blocks' },
    blocks.length
      ? blocks.map((block, index) => renderBlock(block, section, index))
      : h('li', { class: 'blocks-empty' }, 'Drop blocks here'),
  );

  return h(
    'section',
    {
      class: `section${isRoot ? ' root' : ''}${isCollapsed ? ' collapsed' : ''}`,
      style: `--depth: ${depth}`,
      dataset: { id: section.id },
    },
    head,
    list,
  );
}

function renderBlock(block, section, index) {
  const editing = editingBlockId === block.id;
  const host = hostOf(block.source.url);
  const details = [
    block.format === 'html' ? 'HTML' : 'MD',
    formatTokens(block.content.length),
    block.images.length && `${block.images.length} img`,
  ].filter(Boolean);
  const title = blockTitle(block);

  return h(
    'li',
    {
      class: 'block',
      draggable: editing ? null : 'true',
      dataset: { id: block.id, section: section.id, index: String(index) },
    },
    h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
    h(
      'div',
      { class: 'block-main' },
      h('div', { class: 'block-title', title }, title),
      h(
        'div',
        { class: 'block-meta' },
        host && h('a', { href: block.source.url, target: '_blank', title: block.source.title || null }, host),
        host && ' · ',
        details.join(' · '),
      ),
      editing && blockEditor(block),
    ),
    blockMenu(block, section, index),
  );
}

function blockEditor(block) {
  const textarea = h('textarea', {
    class: 'editor',
    spellcheck: 'false',
    'aria-label': 'Block content',
    value: block.content,
  });
  const close = () => {
    editingBlockId = null;
    textarea.blur();
    render();
  };
  return h(
    'div',
    {},
    textarea,
    h(
      'div',
      { class: 'editor-actions' },
      h('button', { type: 'button', onclick: close }, 'Cancel'),
      h(
        'button',
        {
          type: 'button',
          class: 'primary',
          onclick: async () => {
            await op('updateBlock', { blockId: block.id, content: textarea.value });
            close();
          },
        },
        'Save',
      ),
    ),
  );
}

// --- menus -----------------------------------------------------------------------

function menu(label, ...items) {
  return h(
    'details',
    { class: 'menu' },
    h('summary', { 'aria-label': label, title: label }, '⋯'),
    h('div', { class: 'menu-list' }, ...items),
  );
}

function closeMenus(except = null) {
  for (const d of document.querySelectorAll('details.menu[open]')) if (d !== except) d.open = false;
}

function menuItem(label, action, { disabled = false, danger = false } = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: danger ? 'danger' : null,
      disabled,
      onclick: () => {
        closeMenus();
        action();
      },
    },
    label,
  );
}

/** Destructive action: first click arms it, second click (within 3s) runs it. */
function confirmItem(label, action) {
  const btn = h('button', { type: 'button', class: 'danger' }, label);
  armOnClick(btn, label, () => {
    closeMenus();
    action();
  });
  return btn;
}

function armOnClick(btn, label, action) {
  let timer = 0;
  btn.addEventListener('click', () => {
    if (!timer) {
      btn.textContent = 'Click again to confirm';
      timer = setTimeout(() => {
        timer = 0;
        btn.textContent = label;
      }, 3000);
      return;
    }
    clearTimeout(timer);
    timer = 0;
    btn.textContent = label;
    action();
  });
}

function sectionSelect(label, { selected, exclude = () => false, topLevelOption = null, onchange }) {
  const options = orderedSections(state)
    .filter(({ section }) => !exclude(section))
    .map(({ section, depth }) =>
      h(
        'option',
        { value: section.id, selected: section.id === selected },
        `${'  '.repeat(depth)}${depth ? '└ ' : ''}${section.title}`,
      ),
    );
  if (topLevelOption) options.unshift(h('option', { value: '', selected: !selected }, topLevelOption));
  return h(
    'label',
    {},
    label,
    h(
      'select',
      {
        onchange: (e) => {
          closeMenus();
          onchange(e.target.value || null);
        },
      },
      options,
    ),
  );
}

function blockMenu(block, section, index) {
  return menu(
    'Block actions',
    menuItem('Edit content', () => {
      editingBlockId = block.id;
      render();
      els.tree.querySelector(`.block[data-id="${block.id}"] textarea`)?.focus();
    }),
    menuItem('Split section here', () => op('splitSection', { sectionId: section.id, atIndex: index }), {
      disabled: index === 0,
    }),
    sectionSelect('Move to section', {
      selected: section.id,
      onchange: (toSectionId) => op('moveBlock', { blockId: block.id, toSectionId }),
    }),
    h('hr'),
    menuItem('Delete block', () => op('deleteBlock', { blockId: block.id }), { danger: true }),
  );
}

function sectionMenu(section, _entries) {
  const isRoot = section.id === ROOT_ID;
  const siblings = state.sections.filter((s) => s.id !== ROOT_ID && parentKey(s) === parentKey(section));
  const pos = siblings.indexOf(section);

  const addSection = async (parentId) => {
    const res = await op('createSection', { title: 'New section', parentId });
    if (res?.ok) {
      pendingRenameId = res.sectionId;
      render();
    }
  };

  if (isRoot) {
    return menu(
      'Section actions',
      menuItem('Rename', () => startRename(section.id)),
      menuItem('New section', () => addSection(null)),
    );
  }

  return menu(
    'Section actions',
    menuItem('Rename', () => startRename(section.id)),
    menuItem('New sub-section', () => addSection(section.id)),
    menuItem('Move up', () => swapSections(section.id, siblings[pos - 1]?.id), { disabled: pos <= 0 }),
    menuItem('Move down', () => swapSections(section.id, siblings[pos + 1]?.id), {
      disabled: pos === siblings.length - 1,
    }),
    sectionSelect('Nest under', {
      selected: parentKey(section),
      topLevelOption: '(top level)',
      exclude: (s) => s.id === ROOT_ID || isDescendant(s.id, section.id),
      onchange: (parentId) => op('setSectionParent', { sectionId: section.id, parentId }),
    }),
    h('hr'),
    menuItem('Delete section, keep blocks', () => op('deleteSection', { sectionId: section.id, keepBlocks: true })),
    confirmItem('Delete section and blocks', () => op('deleteSection', { sectionId: section.id })),
  );
}

function swapSections(aId, bId) {
  if (!bId) return;
  const order = state.sections.map((s) => s.id);
  const a = order.indexOf(aId);
  const b = order.indexOf(bId);
  [order[a], order[b]] = [order[b], order[a]];
  op('reorderSections', { order });
}

function startRename(sectionId) {
  const titleEl = els.tree.querySelector(`.section[data-id="${sectionId}"] .title`);
  const section = sectionById(sectionId);
  if (!titleEl || !section) return;
  let done = false;
  const input = h('input', { value: section.title, 'aria-label': 'Section title' });
  const finish = (commit) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    input.blur();
    if (commit && title && title !== section.title) op('renameSection', { sectionId, title });
    else render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  titleEl.replaceChildren(input);
  input.focus();
  input.select();
}

// --- drag & drop -------------------------------------------------------------------

function setDropHint(hint) {
  if (dropHint && (dropHint.el !== hint?.el || dropHint.cls !== hint?.cls)) {
    dropHint.el.classList.remove(dropHint.cls);
  }
  dropHint = hint;
  hint?.el.classList.add(hint.cls);
}

function dropTargetFor(e) {
  if (drag?.kind === 'block') {
    const li = e.target.closest('.block');
    if (li) {
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      return {
        el: li,
        cls: after ? 'drop-after' : 'drop-before',
        sectionId: li.dataset.section,
        index: Number(li.dataset.index) + (after ? 1 : 0),
      };
    }
    const sec = e.target.closest('.section');
    if (sec) return { el: sec, cls: 'drop-into', sectionId: sec.dataset.id, index: null };
  }
  if (drag?.kind === 'section') {
    const head = e.target.closest('.section-head');
    const targetId = head?.closest('.section').dataset.id;
    if (!targetId || targetId === drag.id || isDescendant(targetId, drag.id)) return null;
    if (targetId === ROOT_ID) return { el: head, cls: 'drop-after', targetId, zone: 'after' };
    // Top third: before. Bottom third: after. Middle: nest inside.
    const rect = head.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const zone = y < 0.33 ? 'before' : y > 0.67 ? 'after' : 'into';
    const cls = { before: 'drop-before', after: 'drop-after', into: 'drop-into' }[zone];
    return { el: head, cls, targetId, zone };
  }
  return null;
}

async function dropBlock(blockId, sectionId, index) {
  let toIndex = index;
  const from = sectionOfBlock(blockId);
  if (from?.id === sectionId && index != null) {
    const fromIndex = from.blockIds.indexOf(blockId);
    if (fromIndex < index) toIndex--; // account for its own removal
    if (fromIndex === toIndex) return;
  }
  await op('moveBlock', { blockId, toSectionId: sectionId, toIndex: toIndex ?? undefined });
}

async function dropSection(dragId, targetId, zone) {
  const order = state.sections.map((s) => s.id).filter((id) => id !== dragId);
  let parentId;
  if (targetId === ROOT_ID) {
    parentId = null;
    order.splice(1, 0, dragId);
  } else if (zone === 'into') {
    parentId = targetId;
    order.push(dragId);
  } else {
    parentId = parentKey(sectionById(targetId));
    const i = order.indexOf(targetId);
    order.splice(zone === 'after' ? i + 1 : i, 0, dragId);
  }
  if (parentKey(sectionById(dragId)) !== parentId) {
    const res = await op('setSectionParent', { sectionId: dragId, parentId });
    if (!res?.ok) return;
  }
  await op('reorderSections', { order });
}

els.tree.addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('.block');
  const head = e.target.closest?.('.section-head');
  if (li) drag = { kind: 'block', id: li.dataset.id, el: li };
  else if (head) drag = { kind: 'section', id: head.closest('.section').dataset.id, el: head.closest('.section') };
  else return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', drag.id);
  requestAnimationFrame(() => drag?.el.classList.add('dragging'));
});

els.tree.addEventListener('dragover', (e) => {
  const target = dropTargetFor(e);
  setDropHint(target);
  if (target) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
});

els.tree.addEventListener('dragleave', (e) => {
  if (!els.tree.contains(e.relatedTarget)) setDropHint(null);
});

els.tree.addEventListener('drop', (e) => {
  e.preventDefault();
  const target = dropTargetFor(e);
  const current = drag;
  setDropHint(null);
  if (!target || !current) return;
  if (current.kind === 'block') dropBlock(current.id, target.sectionId, target.index);
  else dropSection(current.id, target.targetId, target.zone);
});

els.tree.addEventListener('dragend', () => {
  drag?.el.classList.remove('dragging');
  drag = null;
  setDropHint(null);
});

// Flush a deferred render once the user stops typing in the tree.
els.tree.addEventListener('focusout', () => setTimeout(() => renderPending && render(), 0));

document.addEventListener('click', (e) => closeMenus(e.target.closest('details.menu')));

// --- meta ------------------------------------------------------------------------

els.name.addEventListener('change', () => {
  const name = els.name.value.trim();
  if (name) op('updateMeta', { name });
  else els.name.value = state?.meta.name ?? '';
});
els.desc.addEventListener('change', () => op('updateMeta', { description: els.desc.value.trim() }));

// --- export ------------------------------------------------------------------------

function exportOptions() {
  return {
    mode: document.querySelector('input[name="mode"]:checked').value,
    includeImages: els.images.checked,
    includeSources: els.sources.checked,
  };
}

function loadExportPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(EXPORT_PREFS_KEY) ?? '{}');
    if (prefs.mode) document.querySelector(`input[name="mode"][value="${prefs.mode}"]`)?.click();
    if (typeof prefs.includeImages === 'boolean') els.images.checked = prefs.includeImages;
    if (typeof prefs.includeSources === 'boolean') els.sources.checked = prefs.includeSources;
  } catch {
    // corrupted or unavailable storage: keep defaults
  }
}

document.querySelector('footer.export').addEventListener('change', () => {
  try {
    localStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify(exportOptions()));
  } catch {
    // non-essential
  }
});

const hasBlocks = () => Object.keys(state?.blocks ?? {}).length > 0;

els.preview.addEventListener('click', () => {
  if (!hasBlocks()) return setStatus('Nothing captured yet.', 'warn');
  const files = buildFiles(state, exportOptions());
  els.previewFile.replaceChildren(...files.map((f, i) => h('option', { value: String(i) }, f.path)));
  const show = () => {
    els.previewBody.textContent = files[Number(els.previewFile.value)].content;
    els.previewBody.scrollTop = 0;
  };
  els.previewFile.onchange = show;
  show();
  els.dialog.showModal();
});
els.previewClose.addEventListener('click', () => els.dialog.close());

els.exportBtn.addEventListener('click', async () => {
  if (!hasBlocks()) return setStatus('Nothing captured yet.', 'warn');
  els.exportBtn.disabled = true;
  try {
    const opts = exportOptions();
    setStatus(opts.includeImages ? 'Collecting images…' : 'Packaging…');
    const { blob, filename, fileCount, warnings } = await buildZip(state, {
      ...opts,
      onProgress: (done, total) => setStatus(`Downloading images ${done}/${total}…`),
    });
    setStatus('Saving…');
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename, saveAs: true });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    const summary = `Exported ${filename} (${fileCount} file${fileCount === 1 ? '' : 's'}).`;
    if (warnings.length) {
      setStatus(`${summary}\n${warnings.length} image(s) kept as remote links:\n${warnings.join('\n')}`, 'warn');
    } else {
      setStatus(summary, 'ok');
    }
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, 'error');
  } finally {
    els.exportBtn.disabled = false;
  }
});

armOnClick(els.clear, els.clear.textContent, async () => {
  const res = await op('clearAll');
  if (res?.ok) {
    collapsed.clear();
    editingBlockId = null;
    setStatus('Cleared.', 'ok');
  }
});

// --- boot -----------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  state = changes[STORAGE_KEY].newValue ?? null;
  if (editingBlockId && !state?.blocks[editingBlockId]) editingBlockId = null;
  render();
});

loadExportPrefs();
connect();
({ [STORAGE_KEY]: state = null } = await chrome.storage.local.get(STORAGE_KEY));
render();
