# Skill Maker

Chrome extension (MV3) that captures web documentation and packages it as a
Markdown skill for LLMs (`SKILL.md` + optional `sections/` and `assets/`).

## Install (developer mode)

1. `./scripts/fetch-vendor.sh` (only if `vendor/` is empty)
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder
3. Optional: in the extension's details, enable **Allow access to file URLs** to capture local files

## Use

- Click the toolbar icon (or `Alt+Shift+S`) to open the side panel. Capturing is
  active in that window only while the panel is open.
- **Highlight** text/images, or hold **Alt/⌥** and **click** a container
  (`Alt`+scroll widens/narrows the outline).
- Use the floating bar: **Add to Skill** (root `SKILL.md` body) or **Add to Section…**.
  Already-captured elements get a dashed green outline.
- In the panel: double-click a section to rename, drag blocks/sections to reorder
  (drop on the middle of a section header to nest), `⋯` menus to split, move, edit, delete.
- **Export .zip**: single `SKILL.md`, or an index `SKILL.md` linking to `sections/*.md`.
  Images are downloaded into `assets/` and links rewritten (failures stay remote and are listed).

## Layout

| Path | Role |
| --- | --- |
| `background/service-worker.js` | opens panel, injects/deactivates content scripts, routes state ops |
| `background/store.js` | state schema + all mutations (single writer, serialized) |
| `content/content.js` | selection engine, Alt-hover picker, floating overlay, Turndown conversion |
| `sidepanel/sidepanel.js` | skill manager UI |
| `sidepanel/exporter.js` | Markdown assembly, image fetching, JSZip packaging |
| `shared/messages.js` | message/storage constants shared by all contexts |

## Tests

```sh
npm install        # jsdom, jszip, puppeteer (downloads Chrome for Testing into ~/.cache/puppeteer)
npm test           # unit: store ops, content-script capture/conversion (jsdom), exporter
npm run test:e2e   # loads the unpacked extension in headless Chrome and drives the full flow
```

Set `CHROME_PATH` to use an existing Chrome for Testing / Chromium binary. Branded
Google Chrome ignores `--load-extension`, so it can't run the e2e suite.
The e2e suite opens the side panel page as a tab, because headless Chrome can't
click the toolbar button.

## Publishing

```sh
npm run package        # dist/skill-maker-<version>.zip (runtime files only) + dist/unpacked/
npm run test:package   # package, then run the e2e suite against dist/unpacked
npm run assets         # re-render icons/*.png from icons/icon.svg and the store images in store/
```

Answers for each tab of the Chrome Web Store dashboard are in `store/listing.md`.
The privacy policy is `PRIVACY.md`.
