import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { installFakeChrome } from '../helpers/fake-chrome.mjs';

const fake = installFakeChrome();
const { mutate, ops, load } = await import('../../background/store.js');

/** Run an op the way the service worker does and shape the response the same way. */
const run = (op, payload) =>
  mutate((s) => ops[op](s, payload)).then(
    (result) => ({ ok: true, ...result }),
    (err) => ({ ok: false, error: err.message }),
  );
const add = (content, extra = {}) => run('addBlock', { block: { content, text: content }, ...extra });
const titles = async () => (await load()).sections.map((s) => s.title);

beforeEach(() => fake.reset());

describe('addBlock', () => {
  test('appends to the root section by default', async () => {
    const res = await add('# Hello');
    assert.equal(res.ok, true);
    assert.equal(res.sectionId, 'root');
    const state = await load();
    assert.deepEqual(state.sections[0].blockIds, [res.blockId]);
    assert.equal(state.blocks[res.blockId].format, 'markdown');
  });

  test('rejects empty blocks', async () => {
    const res = await run('addBlock', { block: { content: '   ' } });
    assert.equal(res.ok, false);
    assert.match(res.error, /empty/);
  });

  test('detects duplicates by visible text, regardless of format and whitespace', async () => {
    const first = await run('addBlock', { block: { content: '# Hi', text: 'Hi  there' } });
    const dup = await run('addBlock', {
      sectionTitle: 'API',
      block: { content: '<p>Hi there</p>', format: 'html', text: '  hi THERE ' },
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.duplicate, true);
    assert.equal(dup.blockId, first.blockId);
    assert.equal(dup.sectionId, 'root');
    assert.deepEqual(await titles(), ['Overview'], 'duplicate must not create its section');
  });

  test('force adds a duplicate anyway', async () => {
    await add('same');
    const forced = await add('same', { force: true });
    assert.equal(forced.ok, true);
    assert.equal(Object.keys((await load()).blocks).length, 2);
  });

  test('sectionTitle reuses an existing section case-insensitively', async () => {
    const a = await add('a', { sectionTitle: 'API' });
    const b = await add('b', { sectionTitle: '  api ' });
    assert.equal(a.sectionId, b.sectionId);
    assert.deepEqual(await titles(), ['Overview', 'API']);
  });

  test('only whitelisted fields are stored', async () => {
    const res = await run('addBlock', {
      block: { content: 'x', text: 'x', evil: 1, images: [{ src: 'https://i/a.png', alt: 'A', extra: 1 }] },
    });
    const block = (await load()).blocks[res.blockId];
    assert.equal(block.evil, undefined);
    assert.equal(block.text, undefined, 'text is only used for hashing');
    assert.deepEqual(block.images, [{ src: 'https://i/a.png', alt: 'A' }]);
  });
});

describe('blocks', () => {
  test('deleteBlock frees its fingerprint so it can be captured again', async () => {
    const { blockId } = await add('once');
    await run('deleteBlock', { blockId });
    const again = await add('once');
    assert.equal(again.ok, true);
  });

  test('moveBlock inserts at the requested index', async () => {
    const a = await add('a');
    const b = await add('b');
    const c = await add('c');
    await run('moveBlock', { blockId: c.blockId, toSectionId: 'root', toIndex: 0 });
    assert.deepEqual((await load()).sections[0].blockIds, [c.blockId, a.blockId, b.blockId]);
  });

  test('updateBlock edits content', async () => {
    const { blockId } = await add('old');
    await run('updateBlock', { blockId, content: 'new' });
    assert.equal((await load()).blocks[blockId].content, 'new');
  });
});

describe('sections', () => {
  test('splitSection moves the tail into a sibling placed right after', async () => {
    const x = await add('x', { sectionTitle: 'API' });
    const y = await add('y', { sectionTitle: 'API' });
    await add('z', { sectionTitle: 'Later' });
    const split = await run('splitSection', { sectionId: x.sectionId, atIndex: 1 });
    const state = await load();
    assert.deepEqual(state.sections.map((s) => s.title), ['Overview', 'API', 'API (part 2)', 'Later']);
    assert.deepEqual(state.sections[2].blockIds, [y.blockId]);
    assert.equal(state.sections[2].id, split.sectionId);
  });

  test('splitSection rejects split points at the edges', async () => {
    const { sectionId } = await add('only', { sectionTitle: 'API' });
    assert.equal((await run('splitSection', { sectionId, atIndex: 0 })).ok, false);
    assert.equal((await run('splitSection', { sectionId, atIndex: 1 })).ok, false);
  });

  test('setSectionParent refuses cycles', async () => {
    const parent = await run('createSection', { title: 'Parent' });
    const child = await run('createSection', { title: 'Child', parentId: parent.sectionId });
    const self = await run('setSectionParent', { sectionId: parent.sectionId, parentId: parent.sectionId });
    const loop = await run('setSectionParent', { sectionId: parent.sectionId, parentId: child.sectionId });
    assert.equal(self.ok, false);
    assert.equal(loop.ok, false);
  });

  test('deleteSection reparents children and can keep blocks in root', async () => {
    const parent = await add('p', { sectionTitle: 'Parent' });
    const child = await run('createSection', { title: 'Child', parentId: parent.sectionId });
    await run('deleteSection', { sectionId: parent.sectionId, keepBlocks: true });
    const state = await load();
    assert.equal(state.sections.find((s) => s.id === child.sectionId).parentId, null);
    assert.deepEqual(state.sections[0].blockIds, [parent.blockId]);
  });

  test('deleteSection without keepBlocks deletes the blocks and their fingerprints', async () => {
    const { sectionId, blockId } = await add('gone', { sectionTitle: 'Tmp' });
    await run('deleteSection', { sectionId });
    const state = await load();
    assert.equal(state.blocks[blockId], undefined);
    assert.deepEqual(state.fingerprints, {});
  });

  test('root cannot be deleted or nested', async () => {
    const other = await run('createSection', { title: 'Other' });
    assert.equal((await run('deleteSection', { sectionId: 'root' })).ok, false);
    assert.equal((await run('setSectionParent', { sectionId: 'root', parentId: other.sectionId })).ok, false);
  });

  test('reorderSections keeps root first and requires every id', async () => {
    const a = await run('createSection', { title: 'A' });
    const b = await run('createSection', { title: 'B' });
    await run('reorderSections', { order: [b.sectionId, 'root', a.sectionId] });
    assert.deepEqual(await titles(), ['Overview', 'B', 'A']);
    assert.equal((await run('reorderSections', { order: [a.sectionId] })).ok, false);
  });

  test('renameSection rejects blank titles', async () => {
    assert.equal((await run('renameSection', { sectionId: 'root', title: '  ' })).ok, false);
    await run('renameSection', { sectionId: 'root', title: 'Intro' });
    assert.deepEqual(await titles(), ['Intro']);
  });
});

describe('state', () => {
  test('concurrent mutations are serialized, none are lost', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => add(`block ${i}`)));
    assert.equal((await load()).sections[0].blockIds.length, 25);
  });

  test('a failing op leaves state untouched', async () => {
    await add('keep');
    const before = await load();
    await run('moveBlock', { blockId: 'nope', toSectionId: 'root' });
    assert.deepEqual(await load(), before);
  });

  test('clearAll resets to an empty skill', async () => {
    await add('x', { sectionTitle: 'S' });
    await run('updateMeta', { name: 'Named' });
    await run('clearAll');
    const state = await load();
    assert.deepEqual(state.sections.map((s) => s.id), ['root']);
    assert.deepEqual(state.blocks, {});
    assert.equal(state.meta.name, 'untitled-skill');
  });
});
