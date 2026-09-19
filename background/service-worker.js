// Responsibilities:
//  1. Toolbar click -> open the side panel for that window.
//  2. While a window's side panel is open, keep the capture content script
//     injected and active in that window's tabs; deactivate when it closes.
//  3. Serialize all state mutations (see store.js).
//
// Activation is driven by the side panel's port, not the click itself, so the
// panel being open is the single source of truth — however it was opened.
//
// Side panel contract (implemented in sidepanel.js):
//   const port = chrome.runtime.connect({ name: SM.PORT_PREFIX + windowId });
//   setInterval(() => port.postMessage({ type: SM.MSG.PING }), 20_000);
//   port.onDisconnect -> reconnect (the service worker was restarted).

import '../shared/messages.js';
import { mutate, load, ops } from './store.js';

const { MSG, PORT_PREFIX, STORAGE_KEY } = globalThis.SM;

// Injected in order into the isolated world; each file must be a classic
// script whose top level tolerates the page having been injected before.
const CONTENT_SCRIPTS = [
  'shared/messages.js',
  'vendor/turndown.js',
  'vendor/turndown-plugin-gfm.js',
  'content/content.js',
];
const CONTENT_CSS = ['content/content.css'];
const INJECTABLE_URL = /^(https?|file):/;

/** windowId -> side panel Port. In-memory on purpose: ports die with the worker. */
const activeWindows = new Map();

// --- lifecycle ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const { [STORAGE_KEY]: existing } = await chrome.storage.local.get(STORAGE_KEY);
  if (!existing) await mutate(() => ({})); // persists emptyState()
});

chrome.action.onClicked.addListener((tab) => {
  // Must be called synchronously inside the user gesture — no awaits before it.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
    console.warn('[skill-maker] could not open side panel:', err);
  });
});

// --- side panel presence -----------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(PORT_PREFIX)) return;
  const windowId = Number(port.name.slice(PORT_PREFIX.length));
  if (!Number.isInteger(windowId)) return port.disconnect();

  activeWindows.set(windowId, port);
  // PINGs need no handling: any port message resets the worker's idle timer.
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => {
    if (activeWindows.get(windowId) !== port) return; // superseded by a reconnect
    activeWindows.delete(windowId);
    deactivateWindow(windowId);
  });

  activateActiveTab(windowId);
});

chrome.windows.onRemoved.addListener((windowId) => activeWindows.delete(windowId));

// --- keep tabs in active windows injected ------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active && activeWindows.has(tab.windowId)) {
    activateTab(tab);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (!activeWindows.has(windowId)) return;
  activateTab(await chrome.tabs.get(tabId).catch(() => null));
});

chrome.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
  if (activeWindows.has(newWindowId)) {
    activateTab(await chrome.tabs.get(tabId).catch(() => null));
  } else {
    setTabActive(tabId, false);
  }
});

async function activateActiveTab(windowId) {
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  activateTab(tab);
}

/** tabId -> tail of that tab's activation chain. */
const activations = new Map();

// Serialized per tab: onActivated and onUpdated often fire together, and two
// concurrent probes would both see "not injected" and inject twice.
function activateTab(tab) {
  if (!tab?.id || !INJECTABLE_URL.test(tab.url ?? '')) return;
  const run = (activations.get(tab.id) ?? Promise.resolve()).then(() => injectAndActivate(tab));
  activations.set(tab.id, run);
  run.finally(() => activations.get(tab.id) === run && activations.delete(tab.id));
}

async function injectAndActivate(tab) {
  const target = { tabId: tab.id };
  const panelOpen = async () => {
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    return Boolean(current && activeWindows.has(current.windowId));
  };
  try {
    if (!(await panelOpen())) return;
    // The probe also catches content scripts orphaned by an extension reload:
    // their globals survive but chrome.runtime is gone, so inject a fresh copy.
    const [{ result: alive } = {}] = await chrome.scripting.executeScript({
      target,
      func: () => Boolean(globalThis.__skillMaker?.isAlive?.()),
    });
    if (!alive) {
      await chrome.scripting.insertCSS({ target, files: CONTENT_CSS });
      await chrome.scripting.executeScript({ target, files: CONTENT_SCRIPTS });
    }
    // The panel may have closed while we were injecting; don't re-activate
    // after its deactivation broadcast already went out.
    if (await panelOpen()) await setTabActive(tab.id, true);
  } catch (err) {
    // Chrome Web Store, PDF viewer, file:// without "Allow access to file URLs", etc.
    console.debug(`[skill-maker] cannot activate tab ${tab.id} (${tab.url}):`, err.message);
  }
}

async function deactivateWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  await Promise.all(tabs.map((tab) => setTabActive(tab.id, false)));
}

function setTabActive(tabId, active) {
  // Tabs that were never injected have no listener; that rejection is expected.
  return chrome.tabs.sendMessage(tabId, { type: MSG.SET_ACTIVE, active }).catch(() => {});
}

// --- state mutations ---------------------------------------------------------
// Request:  { type: MSG.OP, op: '<name in store.ops>', payload: {...} }
// Response: { ok: true, ...result } | { ok: false, error } | { ok: false, duplicate: true, ... }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== MSG.OP) return false;
  if (!Object.hasOwn(ops, msg.op)) {
    sendResponse({ ok: false, error: `Unknown op: ${msg.op}` });
    return false;
  }
  mutate((state) => ops[msg.op](state, msg.payload ?? {}))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep sendResponse alive for the async reply
});

// Exposed for debugging from the service worker console: `await debugState()`.
globalThis.debugState = load;
