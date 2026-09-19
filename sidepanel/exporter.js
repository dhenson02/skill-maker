// Turns skill state into files and a .zip. Pure string building except for
// image fetching (extension pages with host permissions bypass CORS).
//
// Single-file:  <name>/SKILL.md [+ assets/*]
// Multi-file:   <name>/SKILL.md (overview + index) + sections/<slug>.md
//               (nested sections: sections/<parent>/<child>.md) [+ assets/*]

const { ROOT_ID } = globalThis.SM;
const IMAGE_CONCURRENCY = 4;
const IMAGE_TIMEOUT_MS = 20_000;
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};
const IMAGE_EXTS = new Set([...Object.values(MIME_EXT), 'jpeg']);

// --- shared helpers (also used by the side panel) ------------------------------

/** Sections in tree order (depth-first), root first. */
export function orderedSections(state) {
  const ids = new Set(state.sections.map((s) => s.id));
  const children = new Map();
  for (const s of state.sections) {
    if (s.id === ROOT_ID) continue;
    const parent = s.parentId && ids.has(s.parentId) ? s.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(s);
  }
  const out = [{ section: state.sections.find((s) => s.id === ROOT_ID), depth: 0 }];
  const walk = (parentId, depth) => {
    for (const section of children.get(parentId) ?? []) {
      out.push({ section, depth });
      walk(section.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** A short human label for a block: its first heading, else its first line. */
export function blockTitle(block) {
  const heading = headingsOf(block)[0];
  if (heading) return truncate(heading, 90);
  const firstLine = block.content
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map((line) => line.replace(/^[\s>*\-+#`|]+/, '').replace(/[*_`[\]]/g, '').trim())
    .find(Boolean);
  if (firstLine) return truncate(firstLine, 90);
  const img = block.images[0];
  return img ? `Image: ${img.alt || img.src.split('/').pop()}` : '(empty)';
}

export function slugify(text, fallback = 'section') {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || fallback;
}

export const skillSlug = (state) => slugify(state.meta.name, 'skill').slice(0, 64);

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- markdown utilities -----------------------------------------------------------

/** Apply fn to each line that is not inside a fenced code block. */
function mapOutsideFences(md, fn) {
  let fence = null;
  return md
    .split('\n')
    .map((line) => {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (m) {
        if (!fence) fence = m[1];
        else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
        return line;
      }
      return fence ? line : fn(line);
    })
    .join('\n');
}

/** Re-level ATX headings so the block's highest heading lands at `top`. */
function shiftHeadings(md, top) {
  let min = 7;
  mapOutsideFences(md, (line) => {
    const m = line.match(/^(#{1,6})\s/);
    if (m) min = Math.min(min, m[1].length);
    return line;
  });
  if (min === 7 || min === top) return md;
  const delta = top - min;
  return mapOutsideFences(md, (line) =>
    line.replace(/^(#{1,6})(?=\s)/, (h) => '#'.repeat(Math.min(6, Math.max(1, h.length + delta)))),
  );
}

function headingsOf(block) {
  const found = [];
  if (block.format === 'html') {
    for (const m of block.content.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
      found.push(m[1].replace(/<[^>]+>/g, '').trim());
    }
  } else {
    mapOutsideFences(block.content, (line) => {
      const m = line.match(/^#{1,3}\s+(.+?)\s*#*\s*$/);
      if (m) found.push(m[1].replace(/[*_`]/g, ''));
      return line;
    });
  }
  return found.filter(Boolean);
}

// GitHub-style heading anchor.
const anchorFor = (title) =>
  title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

const escapeLinkText = (text) => text.replace(/([[\]\\])/g, '\\$1');

const relativePath = (fromFile, toFile) => {
  const from = fromFile.split('/').slice(0, -1);
  const to = toFile.split('/');
  while (from.length && to.length > 1 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => '..'), ...to].join('/');
};

// --- images -------------------------------------------------------------------

function imageRefs(block) {
  const refs = new Set(block.images.map((img) => img.src));
  for (const m of block.content.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) refs.add(m[1]);
  for (const m of block.content.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    refs.add(m[1].replaceAll('&amp;', '&'));
  }
  return [...refs].filter((src) => /^(https?|data):/.test(src));
}

function assetBaseName(src) {
  if (src.startsWith('data:')) return 'image';
  const last = new URL(src).pathname.split('/').filter(Boolean).pop() ?? '';
  return slugify(last.replace(/\.[a-z0-9]+$/i, ''), 'image').slice(0, 40);
}

function assetExtension(src, mime) {
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  // Trust the URL's extension only when the server didn't say what it sent;
  // a text/html login page at /logo.png is not an image.
  if (mime && mime !== 'application/octet-stream') return null;
  if (src.startsWith('data:')) return null;
  const ext = new URL(src).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return ext && IMAGE_EXTS.has(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : null;
}

async function fetchAssets(srcs, onProgress) {
  const map = new Map(); // original src -> "assets/<file>"
  const files = [];
  const warnings = [];
  const used = new Set();
  const queue = [...srcs];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const src = queue.shift();
      try {
        const res = await fetch(src, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const ext = assetExtension(src, blob.type.split(';')[0]);
        if (!ext) throw new Error(`not an image (${blob.type || 'unknown type'})`);
        const base = assetBaseName(src);
        let name = `${base}.${ext}`;
        for (let n = 2; used.has(name); n++) name = `${base}-${n}.${ext}`;
        used.add(name);
        files.push({ path: `assets/${name}`, data: blob });
        map.set(src, `assets/${name}`);
      } catch (err) {
        warnings.push(`Image kept as remote link (${err.message}): ${truncate(src, 120)}`);
      }
      onProgress?.(++done, srcs.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, srcs.length) }, worker));
  return { map, files, warnings };
}

function rewriteImages(content, assetMap, fromFile) {
  // Longest first so a URL that prefixes another can't clobber it.
  const entries = [...assetMap].sort((a, b) => b[0].length - a[0].length);
  for (const [src, path] of entries) {
    const local = relativePath(fromFile, path);
    content = content.split(src).join(local);
    const htmlEscaped = src.replaceAll('&', '&amp;'); // as serialized in HTML blocks
    if (htmlEscaped !== src) content = content.split(htmlEscaped).join(local);
  }
  return content;
}

// --- document building ---------------------------------------------------------------

function frontmatter(state) {
  const hosts = [
    ...new Set(
      Object.values(state.blocks)
        .map((b) => {
          try {
            return new URL(b.source.url).hostname;
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    ),
  ];
  const description =
    state.meta.description.trim() ||
    `Reference documentation for ${state.meta.name}${hosts.length ? `, compiled from ${hosts.join(', ')}` : ''}.`;
  // JSON strings are valid YAML double-quoted scalars.
  return `---\nname: ${skillSlug(state)}\ndescription: ${JSON.stringify(description.replace(/\s+/g, ' '))}\n---`;
}

function renderBlocks(state, section, { headingTop, includeSources, assetMap, file }) {
  const parts = [];
  let lastSource = null;
  for (const id of section.blockIds) {
    const block = state.blocks[id];
    if (!block) continue;
    if (includeSources && block.source.url && block.source.url !== lastSource) {
      const title = escapeLinkText(block.source.title || block.source.url);
      parts.push(`*Source: [${title}](${block.source.url})*`);
    }
    lastSource = block.source.url;
    let body = rewriteImages(block.content.trim(), assetMap, file);
    if (block.format === 'markdown') body = shiftHeadings(body, headingTop);
    parts.push(body);
  }
  return parts.join('\n\n');
}

function hasContent(state, entry, entries) {
  if (entry.section.blockIds.some((id) => state.blocks[id])) return true;
  return entries.some((e) => e.section.parentId === entry.section.id && hasContent(state, e, entries));
}

function sectionSummary(state, section) {
  const headings = section.blockIds
    .flatMap((id) => (state.blocks[id] ? headingsOf(state.blocks[id]) : []))
    .filter((h) => h.toLowerCase() !== section.title.toLowerCase());
  const unique = [...new Set(headings)].slice(0, 4);
  return unique.length ? ` — covers: ${unique.join('; ')}` : '';
}

function buildSingle(state, opts) {
  const file = 'SKILL.md';
  const entries = orderedSections(state);
  const [root, ...rest] = entries;
  const sections = rest.filter((e) => hasContent(state, e, entries));
  const out = [frontmatter(state), `# ${state.meta.name}`];
  if (state.meta.description.trim()) out.push(state.meta.description.trim());

  const rootBody = renderBlocks(state, root.section, { ...opts, headingTop: 2, file });
  if (rootBody) out.push(rootBody);

  if (sections.length > 1) {
    const toc = sections.map(
      ({ section, depth }) => `${'  '.repeat(depth)}- [${escapeLinkText(section.title)}](#${anchorFor(section.title)})`,
    );
    out.push(`## Contents\n\n${toc.join('\n')}`);
  }
  for (const { section, depth } of sections) {
    out.push(`${'#'.repeat(Math.min(6, 2 + depth))} ${section.title}`);
    const body = renderBlocks(state, section, { ...opts, headingTop: Math.min(6, 3 + depth), file });
    if (body) out.push(body);
  }
  return [{ path: file, content: `${out.join('\n\n')}\n` }];
}

function buildMulti(state, opts) {
  const entries = orderedSections(state);
  const [root, ...rest] = entries;
  const sections = rest.filter((e) => hasContent(state, e, entries));

  // Assign unique paths; children live in a folder named after their parent.
  const pathOf = new Map();
  const usedPaths = new Set();
  for (const { section } of sections) {
    const dir = pathOf.has(section.parentId) ? pathOf.get(section.parentId).replace(/\.md$/, '') : 'sections';
    const base = slugify(section.title);
    let path = `${dir}/${base}.md`;
    for (let n = 2; usedPaths.has(path); n++) path = `${dir}/${base}-${n}.md`;
    usedPaths.add(path);
    pathOf.set(section.id, path);
  }

  const files = [];
  for (const { section } of sections) {
    const file = pathOf.get(section.id);
    const out = [`# ${section.title}`];
    const body = renderBlocks(state, section, { ...opts, headingTop: 2, file });
    if (body) out.push(body);
    const kids = sections.filter((e) => e.section.parentId === section.id);
    if (kids.length) {
      const links = kids.map(
        ({ section: kid }) =>
          `- [${escapeLinkText(kid.title)}](${relativePath(file, pathOf.get(kid.id))})${sectionSummary(state, kid)}`,
      );
      out.push(`## Sub-sections\n\n${links.join('\n')}`);
    }
    files.push({ path: file, content: `${out.join('\n\n')}\n` });
  }

  const index = [frontmatter(state), `# ${state.meta.name}`];
  if (state.meta.description.trim()) index.push(state.meta.description.trim());
  const rootBody = renderBlocks(state, root.section, { ...opts, headingTop: 2, file: 'SKILL.md' });
  if (rootBody) index.push(rootBody);
  if (sections.length) {
    const links = sections.map(
      ({ section, depth }) =>
        `${'  '.repeat(depth)}- [${escapeLinkText(section.title)}](${pathOf.get(section.id)})${sectionSummary(state, section)}`,
    );
    index.push(
      `## Reference files\n\nDetailed documentation is split by topic. Read only the files relevant to the task.\n\n${links.join('\n')}`,
    );
  }
  files.unshift({ path: 'SKILL.md', content: `${index.join('\n\n')}\n` });
  return files;
}

/**
 * @param {object} opts { mode: 'single'|'multi', includeSources: boolean, assetMap?: Map }
 * @returns {{ path: string, content: string }[]}
 */
export function buildFiles(state, { mode = 'single', includeSources = true, assetMap = new Map() } = {}) {
  const opts = { includeSources, assetMap };
  return mode === 'multi' ? buildMulti(state, opts) : buildSingle(state, opts);
}

/**
 * @param {object} opts { mode, includeSources, includeImages, onProgress(done, total) }
 * @returns {Promise<{ blob: Blob, filename: string, fileCount: number, warnings: string[] }>}
 */
export async function buildZip(state, { mode, includeSources = true, includeImages = true, onProgress } = {}) {
  let assets = { map: new Map(), files: [], warnings: [] };
  if (includeImages) {
    const srcs = [...new Set(Object.values(state.blocks).flatMap(imageRefs))];
    assets = await fetchAssets(srcs, onProgress);
  }
  const files = buildFiles(state, { mode, includeSources, assetMap: assets.map });

  const name = skillSlug(state);
  const zip = new JSZip();
  const folder = zip.folder(name);
  for (const { path, content } of files) folder.file(path, content);
  for (const { path, data } of assets.files) folder.file(path, data);

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return {
    blob,
    filename: `${name}.zip`,
    fileCount: files.length + assets.files.length,
    warnings: assets.warnings,
  };
}
