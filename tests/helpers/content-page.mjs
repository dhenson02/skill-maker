// Loads content/content.js into a jsdom page with a fake extension runtime.
// The overlay's closed shadow root is forced open so tests can drive it.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ROOT = new URL('../../', import.meta.url);
const SCRIPTS = ['shared/messages.js', 'vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'content/content.js'];

/**
 * @param {string} body  HTML for <body>
 * @param {object} opts  { url, prefs, reply(msg, sentCount) -> response }
 */
export async function loadContentPage(body, { url = 'https://docs.example.com/start#top', prefs = {}, reply } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Docs Page</title></head><body>${body}</body></html>`, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;

  let shadow;
  const attachShadow = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function () {
    shadow = attachShadow.call(this, { mode: 'open' });
    return shadow;
  };
  // jsdom has no layout; any rect will do.
  w.Range.prototype.getBoundingClientRect = () => ({ top: 100, left: 10, right: 400, bottom: 120, width: 390, height: 20 });

  const sent = [];
  const messageListeners = [];
  const respond = reply ?? ((_msg, n) => ({ ok: true, blockId: `b${n}`, sectionId: 'root' }));
  w.chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: (fn) => messageListeners.push(fn), removeListener() {} },
      sendMessage: async (msg) => {
        sent.push(structuredClone(msg)); // like real messaging; also moves it out of the jsdom realm
        return respond(msg, sent.length);
      },
    },
    storage: {
      local: { get: async () => ({ skillMakerPrefs: prefs }), set: async () => {} },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };

  for (const file of SCRIPTS) w.eval(readFileSync(new URL(file, ROOT), 'utf8'));
  for (const fn of messageListeners) fn({ type: 'sm:set-active', active: true });

  const d = w.document;
  const mouse = (el, type, init = {}) =>
    el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0, ...init }));
  const tick = () => new Promise((r) => setTimeout(r, 10));
  await tick(); // let the content script finish loading prefs from storage

  return {
    window: w,
    document: d,
    shadow,
    sent,
    tick,
    mouse,
    /** Simulate the service worker's SET_ACTIVE broadcast. */
    setActive: (active) => messageListeners.forEach((fn) => fn({ type: 'sm:set-active', active })),
    /** Hover with Alt held, optionally widen `widen` levels, then Alt+click. */
    async altPick(el, widen = 0) {
      mouse(el, 'mousemove', { altKey: true });
      for (let i = 0; i < widen; i++) {
        w.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100, altKey: true, cancelable: true }));
      }
      const notCancelled = mouse(el, 'click', { altKey: true });
      await tick();
      return { defaultPrevented: !notCancelled };
    },
    /** Programmatically select a range, then fire the mouseup the engine listens for. */
    async select(startNode, startOffset, endNode, endOffset) {
      const range = d.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      d.getSelection().removeAllRanges();
      d.getSelection().addRange(range);
      mouse(startNode.parentElement ?? startNode, 'mouseup');
      await tick();
    },
    ui: (selector) => shadow.querySelector(selector),
    async clickUi(selector) {
      shadow.querySelector(selector).click();
      await tick();
    },
    async addToSection(title) {
      shadow.querySelector('[data-action="section"]').click();
      shadow.querySelector('input[name="section"]').value = title;
      shadow.querySelector('.section-form').requestSubmit();
      await tick();
    },
    toastText: () => shadow.querySelector('.toast .msg').textContent,
    lastBlock: () => sent.at(-1)?.payload.block,
  };
}
