// Skill state lives in chrome.storage.local under a single key. The service
// worker is the only writer: every mutation runs through a serialized queue so
// concurrent captures from several tabs can't clobber each other. Readers (side
// panel, content scripts) read storage directly and react to storage.onChanged.
//
// Shape:
// {
//   version: 1,
//   meta:     { name, description },             // SKILL.md frontmatter
//   sections: [{ id, title, parentId, blockIds }], // array order = display/export order
//   blocks:   { [id]: { id, fingerprint, capturedAt, format, content, images, source, selector } },
//   fingerprints: { [sha256(normalized text)]: blockId }, // dedup index
// }
// The root section (id 'root') is the body of SKILL.md itself and is always first.

import '../shared/messages.js';

const { STORAGE_KEY, ROOT_ID } = globalThis.SM;
const SCHEMA_VERSION = 1;

export function emptyState() {
  return {
    version: SCHEMA_VERSION,
    meta: { name: 'untitled-skill', description: '' },
    sections: [{ id: ROOT_ID, title: 'Overview', parentId: null, blockIds: [] }],
    blocks: {},
    fingerprints: {},
  };
}

export async function load() {
  const { [STORAGE_KEY]: state } = await chrome.storage.local.get(STORAGE_KEY);
  return state?.version === SCHEMA_VERSION ? state : emptyState();
}

let tail = Promise.resolve();

/** Run `fn(state)` exclusively; state is saved only if fn doesn't throw. */
export function mutate(fn) {
  const run = tail.then(async () => {
    const state = await load();
    const result = await fn(state);
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    return result;
  });
  tail = run.catch(() => {});
  return run;
}

// --- helpers ---------------------------------------------------------------

const normalize = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();

async function fingerprint(block) {
  // Hash the visible text, not the output format, so the same element captured
  // once as Markdown and once as HTML is still recognized as a duplicate.
  const basis =
    normalize(block.text || block.content || '') ||
    (block.images ?? []).map((img) => img.src).join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function requireSection(state, id) {
  const section = state.sections.find((s) => s.id === id);
  if (!section) throw new Error(`Unknown section: ${id}`);
  return section;
}

function requireBlock(state, id) {
  if (!state.blocks[id]) throw new Error(`Unknown block: ${id}`);
  return state.blocks[id];
}

const sectionOfBlock = (state, blockId) =>
  state.sections.find((s) => s.blockIds.includes(blockId));

function getOrCreateSection(state, title) {
  const wanted = title.trim();
  if (!wanted) return requireSection(state, ROOT_ID);
  const existing = state.sections.find((s) => s.title.toLowerCase() === wanted.toLowerCase());
  if (existing) return existing;
  const section = { id: crypto.randomUUID(), title: wanted, parentId: null, blockIds: [] };
  state.sections.push(section);
  return section;
}

const clampIndex = (i, len) => (Number.isInteger(i) ? Math.max(0, Math.min(i, len)) : len);

function isDescendant(state, candidateId, ancestorId) {
  for (let id = candidateId; id; id = state.sections.find((s) => s.id === id)?.parentId) {
    if (id === ancestorId) return true;
  }
  return false;
}

// --- operations ------------------------------------------------------------
// Each op mutates `state` in place and returns a plain result object.

export const ops = {
  async addBlock(state, { sectionId, sectionTitle, block, force = false }) {
    if (!block || !(block.content?.trim() || block.images?.length)) {
      throw new Error('Nothing to add: selection is empty');
    }
    const fp = await fingerprint(block);
    const existingId = state.fingerprints[fp];
    if (existingId && state.blocks[existingId] && !force) {
      return {
        ok: false,
        duplicate: true,
        blockId: existingId,
        sectionId: sectionOfBlock(state, existingId)?.id,
      };
    }

    const section = sectionTitle
      ? getOrCreateSection(state, sectionTitle)
      : requireSection(state, sectionId ?? ROOT_ID);

    const id = crypto.randomUUID();
    state.blocks[id] = {
      id,
      fingerprint: fp,
      capturedAt: Date.now(),
      format: block.format === 'html' ? 'html' : 'markdown',
      content: String(block.content ?? ''),
      images: (block.images ?? []).map(({ src, alt = '' }) => ({ src, alt })),
      source: { url: block.sourceUrl ?? '', title: block.sourceTitle ?? '' },
      selector: block.selector ?? null,
    };
    state.fingerprints[fp] = id;
    section.blockIds.push(id);
    return { blockId: id, sectionId: section.id };
  },

  updateBlock(state, { blockId, content }) {
    requireBlock(state, blockId).content = String(content);
    return { blockId };
  },

  deleteBlock(state, { blockId }) {
    const block = requireBlock(state, blockId);
    const section = sectionOfBlock(state, blockId);
    if (section) section.blockIds = section.blockIds.filter((id) => id !== blockId);
    if (state.fingerprints[block.fingerprint] === blockId) delete state.fingerprints[block.fingerprint];
    delete state.blocks[blockId];
    return { blockId };
  },

  moveBlock(state, { blockId, toSectionId, toIndex }) {
    requireBlock(state, blockId);
    const target = requireSection(state, toSectionId);
    const source = sectionOfBlock(state, blockId);
    if (source) source.blockIds = source.blockIds.filter((id) => id !== blockId);
    target.blockIds.splice(clampIndex(toIndex, target.blockIds.length), 0, blockId);
    return { blockId, sectionId: target.id };
  },

  createSection(state, { title, parentId = null }) {
    if (parentId && parentId !== ROOT_ID) requireSection(state, parentId);
    const section = {
      id: crypto.randomUUID(),
      title: title?.trim() || 'New section',
      parentId: parentId === ROOT_ID ? null : parentId,
      blockIds: [],
    };
    state.sections.push(section);
    return { sectionId: section.id };
  },

  renameSection(state, { sectionId, title }) {
    const trimmed = title?.trim();
    if (!trimmed) throw new Error('Section title cannot be empty');
    requireSection(state, sectionId).title = trimmed;
    return { sectionId };
  },

  /** keepBlocks: true moves the section's blocks to root instead of deleting them. */
  deleteSection(state, { sectionId, keepBlocks = false }) {
    if (sectionId === ROOT_ID) throw new Error('The root section cannot be deleted');
    const section = requireSection(state, sectionId);
    for (const child of state.sections) {
      if (child.parentId === sectionId) child.parentId = section.parentId;
    }
    if (keepBlocks) {
      requireSection(state, ROOT_ID).blockIds.push(...section.blockIds);
    } else {
      for (const blockId of section.blockIds) {
        const { fingerprint: fp } = state.blocks[blockId] ?? {};
        if (state.fingerprints[fp] === blockId) delete state.fingerprints[fp];
        delete state.blocks[blockId];
      }
    }
    state.sections = state.sections.filter((s) => s.id !== sectionId);
    return { sectionId };
  },

  /** order: every section id in the desired order. Root is pinned first. */
  reorderSections(state, { order }) {
    const ids = new Set(state.sections.map((s) => s.id));
    if (!Array.isArray(order) || order.length !== ids.size || !order.every((id) => ids.has(id))) {
      throw new Error('Section order must list every section exactly once');
    }
    const byId = new Map(state.sections.map((s) => [s.id, s]));
    state.sections = [ROOT_ID, ...order.filter((id) => id !== ROOT_ID)].map((id) => byId.get(id));
    return {};
  },

  setSectionParent(state, { sectionId, parentId }) {
    if (sectionId === ROOT_ID) throw new Error('The root section cannot be nested');
    const section = requireSection(state, sectionId);
    const newParent = parentId === ROOT_ID ? null : parentId ?? null;
    if (newParent) {
      requireSection(state, newParent);
      if (isDescendant(state, newParent, sectionId)) throw new Error('A section cannot be nested inside itself');
    }
    section.parentId = newParent;
    return { sectionId };
  },

  /** Moves blocks [atIndex..] into a new sibling section placed right after the source. */
  splitSection(state, { sectionId, atIndex, title }) {
    const section = requireSection(state, sectionId);
    if (!Number.isInteger(atIndex) || atIndex <= 0 || atIndex >= section.blockIds.length) {
      throw new Error('Split point must fall between two blocks');
    }
    const parts = state.sections.filter((s) => s.title.startsWith(section.title)).length;
    const created = {
      id: crypto.randomUUID(),
      title: title?.trim() || `${section.title} (part ${parts + 1})`,
      parentId: sectionId === ROOT_ID ? null : section.parentId,
      blockIds: section.blockIds.splice(atIndex),
    };
    state.sections.splice(state.sections.indexOf(section) + 1, 0, created);
    return { sectionId: created.id };
  },

  updateMeta(state, { name, description }) {
    if (name !== undefined) state.meta.name = String(name);
    if (description !== undefined) state.meta.description = String(description);
    return {};
  },

  clearAll(state) {
    Object.assign(state, emptyState());
    return {};
  },
};
