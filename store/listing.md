# Chrome Web Store submission kit

This file has copy-paste answers for each tab of the Developer Dashboard.
Upload `dist/skill-maker-<version>.zip` (made with `npm run package`), not the repository folder.

---

## Package

| Field | Value |
| --- | --- |
| Upload | `dist/skill-maker-0.1.0.zip` |
| Visibility (first release) | **Unlisted** or **Private** (trusted testers) is a good first step; switch to Public once it's approved |

## Store listing tab

**Name** (from the manifest): Skill Maker

**Summary** (from the manifest description, max 132 characters):
> Capture web documentation and package it as modular Markdown skills for LLMs.

**Category:** Developer Tools
**Language:** English

**Description:**

> Skill Maker turns documentation you read on the web into a skill package an LLM can use: a `SKILL.md` file, with optional section files and images.
>
> HOW IT WORKS
> 1. Click the Skill Maker icon to open the side panel. Capturing is active only while the panel is open.
> 2. Highlight any text, or hold Alt (Option on Mac) and click a whole section of a page. Alt + scroll widens or narrows the outline.
> 3. Use the floating button to add the content to your skill, either to the main document or to a named section.
> 4. Organize in the side panel: rename sections, drag to reorder or nest them, split long sections, and edit or delete blocks.
> 5. Export a .zip file: one structured SKILL.md, or an index SKILL.md that links to one Markdown file per section.
>
> FEATURES
> • Clean Markdown conversion that keeps headings, code blocks (with their language), tables and lists
> • Removes page clutter such as copy buttons, heading anchor links and icons
> • Detects duplicates, so the same content isn't captured twice
> • Downloads images into assets/ and rewrites their links (optional)
> • Adds source links so the model can cite where each part came from
> • Content persists across pages and browser restarts until you clear it
>
> PRIVACY
> Everything stays in your browser. There are no accounts, no analytics, and nothing is sent to any server. See the privacy policy for details.

**Graphic assets** (made with `npm run assets`):

| Asset | File | Required |
| --- | --- | --- |
| Store icon 128×128 | `icons/icon-128.png` (taken from the package) | yes |
| Screenshot 1280×800 | `store/screenshot-1-capture.png` | yes (1–5) |
| Screenshot 1280×800 | `store/screenshot-2-export.png` | |
| Small promo tile 440×280 | `store/promo-small.png` | yes |
| Marquee 1400×560 | not made | optional |

## Privacy tab

**Single purpose description:**
> Skill Maker captures content the user selects on web pages and packages it into Markdown files (an LLM "skill") that the user downloads.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `sidePanel` | The whole interface is a side panel. It stays open while the user moves between pages and picks the content to capture. |
| `storage` | Saves the captured content and the user's settings locally, so they persist across pages and browser restarts until the user clears them. |
| `unlimitedStorage` | Captured documentation can be large (many pages of text, including inline images), so it can exceed the default 10 MB local storage quota. Data never leaves the device. |
| `scripting` | Injects the selection script (highlighting, Alt+click to pick an element, the "Add to Skill" button) into the current tab, and only while the side panel is open. It isn't declared as an always-on content script. |
| `downloads` | Saves the exported .zip file to the location the user chooses. |
| Host permission `<all_urls>` | Documentation can be on any website. The extension needs to (1) inject the selection script into whichever page the user is reading while the panel is open, including after they navigate to other pages, and (2) download the images in captured content from their hosting sites during export. It reads pages only while the side panel is open, and saves only content the user explicitly adds. |

**Remote code:** No, I am not using remote code. (Turndown, turndown-plugin-gfm and JSZip are bundled in `vendor/`.)

**Data usage.** Check:
- ☑ **Website content** (the text, images and page URLs the user chooses to capture)

Nothing else is collected. All three certifications apply:
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** the published address of `PRIVACY.md` (see the README's publishing steps).

## Distribution tab

- Payments: free
- Regions: all regions
