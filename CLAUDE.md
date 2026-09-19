# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Skill Maker is a Chrome MV3 extension that captures web documentation (text selections or Alt+clicked containers) and exports it as an LLM skill package: `SKILL.md` plus optional `sections/*.md` and `assets/`. See README.md for the user-facing flow.

The extension has **no build step**. Source files are loaded by Chrome as they are. `package.json` exists only for test tooling (Node ≥ 22). Third-party libraries (Turndown, turndown-plugin-gfm, JSZip) are vendored in `vendor/` because MV3 forbids remotely hosted code. Run `./scripts/fetch-vendor.sh` to re-download them.

## Commands

```sh
npm install                 # jsdom, jszip, puppeteer (downloads Chrome for Testing)
npm test                    # unit tests (node:test): store, content script under jsdom, exporter
npm run test:e2e            # loads the unpacked extension in headless Chrome for Testing
npm run test:all

node --test tests/unit/store.test.mjs                        # a single file
node --test --test-name-pattern='dedup' 'tests/unit/*.test.mjs'   # tests matching a name
```

- The e2e suite needs Chrome for Testing or Chromium. Branded Google Chrome ignores `--load-extension`. Set `CHROME_PATH` to use an existing binary.
- Headless Chrome can't click the toolbar button, so e2e opens `sidepanel/sidepanel.html` as a tab in the same window. It registers the same way the real panel does.
- To load the extension manually: `chrome://extensions` → Developer mode → Load unpacked → this folder.

## Architecture

There are three execution contexts. They communicate only through `chrome.runtime` messaging and `chrome.storage.local`:

1. **Service worker** (`background/service-worker.js`, ES module)
   - It is the **only writer** of skill state. Every mutation arrives as `{ type: SM.MSG.OP, op, payload }` and is dispatched to a function in `store.ops`.
   - `store.mutate()` serializes all ops through a promise queue: load → run the op → save. State is saved only if the op doesn't throw.
   - To add a new mutation, add a function to `ops` in `background/store.js`. No routing changes are needed.
   - Responses look like `{ ok: true, ...result }` or `{ ok: false, error }`. `addBlock` can also return `{ ok: false, duplicate: true, blockId, sectionId }`; the caller can retry with `force: true`.

2. **Content script** (`content/content.js`)
   - It is **never declared in the manifest**. The service worker injects it on demand with `chrome.scripting`, in this order: `shared/messages.js`, the Turndown vendor files, then `content.js`.
   - Every injected file must be a classic script that tolerates being injected again into the same isolated world. That's why `shared/messages.js` has no top-level `const`/`let`, and `content.js` is wrapped in an IIFE.
   - After an extension reload, an orphaned copy of the script can remain on the page. The new copy retires it by dispatching a `skill-maker:teardown` DOM event. The service worker detects the orphan with the `globalThis.__skillMaker.isAlive()` probe.
   - The overlay UI lives in a **closed** shadow root. The unit tests force it open (see `tests/helpers/content-page.mjs`). The e2e tests reach it through CDP.

3. **Side panel** (`sidepanel/sidepanel.js` + `exporter.js`, ES modules)
   - It reads state directly from storage and re-renders on `storage.onChanged`.
   - It writes only by sending ops to the service worker.

**Capture activation follows side panel presence.** The panel opens a port named `sm-panel:<windowId>` and pings it every 20s, which keeps the worker alive. While that port is connected, the worker injects the content script into the active tab of that window and sends it `SET_ACTIVE`. When the port disconnects, the worker deactivates every tab in the window. Injection is serialized per tab, because `onActivated` and `onUpdated` fire together. The worker also re-checks that the panel is still open after injecting.

**State schema** is documented at the top of `background/store.js` (`version: 1`). A few details that matter:
- The `root` section is the `SKILL.md` body. It is always first and can't be deleted or nested.
- Sections form a tree through `parentId`. The order of the `sections` array is the sibling order. `exporter.orderedSections()` produces the depth-first tree order used by both the panel and the export.
- Duplicates are detected with `fingerprints`: a SHA-256 of the normalized visible text, not the output format. Any op that deletes blocks must clean up the matching fingerprint entry.
- If `version` doesn't match, `load()` returns an empty state. A schema change needs a version bump or a migration.

**Globals:** `shared/messages.js` defines `globalThis.SM`, which holds the message types, the port prefix, the storage keys and `ROOT_ID`. `exporter.js` depends on the page globals `SM` and `JSZip`, which `sidepanel.html` loads as classic scripts. The unit tests stub both before they dynamically `import()` the module. `store.test.mjs` installs an in-memory `chrome.storage` from `tests/helpers/fake-chrome.mjs` before importing the store.

**Export** (`sidepanel/exporter.js`) builds everything as strings, except image fetching: extension pages with host permissions bypass CORS. It shifts heading levels outside code fences. Images are downloaded into `assets/` and their links rewritten. Images that fail to download keep their remote URLs and are reported to the user.
