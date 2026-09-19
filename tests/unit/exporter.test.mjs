import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import JSZip from 'jszip';

// exporter.js expects the page globals the side panel provides.
globalThis.SM = { ROOT_ID: 'root' };
globalThis.JSZip = JSZip;
const { blockTitle, buildFiles, buildZip, orderedSections, slugify } = await import('../../sidepanel/exporter.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const IMG = 'https://docs.example.com/img/diagram.png?w=1&h=2';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return handler(url);
  };
  return calls;
}
const pngResponse = () => ({ ok: true, blob: async () => new Blob([PNG], { type: 'image/png' }) });

function fixture() {
  const block = (id, content, extra = {}) => ({
    id,
    format: 'markdown',
    content,
    images: [],
    source: { url: 'https://docs.example.com/auth', title: 'Auth' },
    ...extra,
  });
  return {
    version: 1,
    meta: { name: 'Example API', description: '' },
    sections: [
      { id: 'root', title: 'Overview', parentId: null, blockIds: ['b0'] },
      { id: 's1', title: 'Auth', parentId: null, blockIds: ['b1', 'b2'] },
      { id: 's2', title: 'OAuth Flows', parentId: 's1', blockIds: ['b3'] },
      { id: 's3', title: 'Empty', parentId: null, blockIds: [] },
    ],
    blocks: {
      b0: block('b0', '# Intro\n\nHello.', { source: { url: 'https://docs.example.com/', title: 'Home' } }),
      b1: block('b1', `## Tokens\n\n\`\`\`bash\n# not a heading\ncurl x\n\`\`\`\n\n![D](${IMG})`, {
        images: [{ src: IMG, alt: 'D' }],
        source: { url: 'https://docs.example.com/auth', title: 'Auth [v2]' },
      }),
      b2: block('b2', `<p>raw <img src="${IMG.replace('&', '&amp;')}"><img src="https://x.com/missing.png"></p>`, {
        format: 'html',
      }),
      b3: block('b3', '#### Deep\n\ntext', { source: { url: 'https://docs.example.com/oauth', title: 'OAuth' } }),
    },
    fingerprints: {},
  };
}

const fileMap = (files) => Object.fromEntries(files.map((f) => [f.path, f.content]));

describe('helpers', () => {
  test('orderedSections walks the tree depth-first with root first', () => {
    const order = orderedSections(fixture()).map(({ section, depth }) => `${section.id}:${depth}`);
    assert.deepEqual(order, ['root:0', 's1:0', 's2:1', 's3:0']);
  });

  test('orderedSections treats a dangling parentId as top level', () => {
    const state = fixture();
    state.sections[2].parentId = 'deleted';
    assert.equal(orderedSections(state).find((e) => e.section.id === 's2').depth, 0);
  });

  test('blockTitle prefers the first heading, then the first line', () => {
    const state = fixture();
    assert.equal(blockTitle(state.blocks.b1), 'Tokens');
    assert.equal(blockTitle({ format: 'markdown', content: '> **Note:** be careful', images: [] }), 'Note: be careful');
  });

  test('slugify', () => {
    assert.equal(slugify('Crème Brûlée & API v2!'), 'creme-brulee-api-v2');
    assert.equal(slugify('!!!'), 'section');
  });
});

describe('single-file export', () => {
  const skill = () => fileMap(buildFiles(fixture(), { mode: 'single' }))['SKILL.md'];

  test('produces only SKILL.md with valid frontmatter', () => {
    const files = buildFiles(fixture(), { mode: 'single' });
    assert.deepEqual(files.map((f) => f.path), ['SKILL.md']);
    assert.match(
      skill(),
      /^---\nname: example-api\ndescription: "Reference documentation for Example API, compiled from docs\.example\.com\."\n---\n\n# Example API\n/,
    );
  });

  test('uses the user description when set', () => {
    const state = fixture();
    state.meta.description = 'Use when calling\nthe "Example" API.';
    const md = fileMap(buildFiles(state, { mode: 'single' }))['SKILL.md'];
    assert.match(md, /^description: "Use when calling the \\"Example\\" API\."$/m);
  });

  test('nests section headings and re-levels captured headings below them', () => {
    const md = skill();
    assert.match(md, /^## Intro$/m, 'root block headings start at h2');
    assert.match(md, /^## Auth$/m);
    assert.match(md, /^### Tokens$/m);
    assert.match(md, /^### OAuth Flows$/m);
    assert.match(md, /^#### Deep$/m);
  });

  test('never re-levels "#" lines inside fenced code', () => {
    assert.match(skill(), /```bash\n# not a heading\ncurl x\n```/);
  });

  test('adds a table of contents and skips empty sections', () => {
    const md = skill();
    assert.match(md, /## Contents\n\n- \[Auth\]\(#auth\)\n {2}- \[OAuth Flows\]\(#oauth-flows\)/);
    assert.doesNotMatch(md, /Empty/);
  });

  test('source links appear once per run of blocks from the same page', () => {
    const md = skill();
    assert.equal(md.match(/\*Source: \[Auth \\\[v2\\\]\]/g).length, 1, 'escaped brackets, not repeated for b2');
    assert.doesNotMatch(fileMap(buildFiles(fixture(), { includeSources: false }))['SKILL.md'], /Source:/);
  });
});

describe('multi-file export', () => {
  const files = () => fileMap(buildFiles(fixture(), { mode: 'multi' }));

  test('writes an index plus nested section files', () => {
    assert.deepEqual(Object.keys(files()), ['SKILL.md', 'sections/auth.md', 'sections/auth/oauth-flows.md']);
  });

  test('index links to every section with a coverage summary', () => {
    const index = files()['SKILL.md'];
    assert.match(index, /^- \[Auth\]\(sections\/auth\.md\) — covers: Tokens$/m);
    assert.match(index, /^ {2}- \[OAuth Flows\]\(sections\/auth\/oauth-flows\.md\)$/m);
  });

  test('section files start at h1 and link their children relatively', () => {
    const auth = files()['sections/auth.md'];
    assert.match(auth, /^# Auth\n/);
    assert.match(auth, /^## Tokens$/m);
    assert.match(auth, /## Sub-sections\n\n- \[OAuth Flows\]\(auth\/oauth-flows\.md\)/);
    assert.match(files()['sections/auth/oauth-flows.md'], /^# OAuth Flows\n[\s\S]*^## Deep$/m);
  });

  test('duplicate section titles get unique file names', () => {
    const state = fixture();
    state.sections[3] = { id: 's3', title: 'Auth', parentId: null, blockIds: ['b0'] };
    assert.ok(fileMap(buildFiles(state, { mode: 'multi' }))['sections/auth-2.md']);
  });
});

describe('zip packaging', () => {
  test('downloads images into assets/ and rewrites Markdown and HTML references', async () => {
    const calls = fakeFetch((url) => (url.includes('missing') ? { ok: false, status: 404 } : pngResponse()));
    const { blob, filename, fileCount, warnings } = await buildZip(fixture(), { mode: 'multi' });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);

    assert.equal(filename, 'example-api.zip');
    assert.deepEqual(calls.sort(), [IMG, 'https://x.com/missing.png'].sort(), 'each image fetched once');
    assert.ok(paths.includes('example-api/assets/diagram.png'));
    assert.equal(fileCount, 4);

    const auth = await zip.file('example-api/sections/auth.md').async('string');
    assert.match(auth, /!\[D\]\(\.\.\/assets\/diagram\.png\)/);
    assert.match(auth, /<img src="\.\.\/assets\/diagram\.png">/, 'HTML &amp; form rewritten too');
    assert.match(auth, /<img src="https:\/\/x\.com\/missing\.png">/, 'failed image stays remote');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /HTTP 404/);
  });

  test('rejects non-image responses', async () => {
    fakeFetch(() => ({ ok: true, blob: async () => new Blob(['<html>login</html>'], { type: 'text/html' }) }));
    const { warnings } = await buildZip(fixture(), { mode: 'single' });
    assert.ok(warnings.some((w) => /not an image/.test(w)));
  });

  test('includeImages: false leaves image URLs remote and fetches nothing', async () => {
    const calls = fakeFetch(pngResponse);
    const { blob } = await buildZip(fixture(), { mode: 'single', includeImages: false });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    assert.equal(calls.length, 0);
    assert.match(await zip.file('example-api/SKILL.md').async('string'), /!\[D\]\(https:\/\/docs\.example\.com/);
  });
});
