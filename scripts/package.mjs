// Builds the Chrome Web Store upload: dist/skill-maker-<version>.zip, plus an
// unpacked copy in dist/unpacked/ so the e2e suite can test exactly what ships.
// Only runtime files are included (no tests, node_modules, docs or icon sources),
// and the build fails if anything the extension references is missing.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import JSZip from 'jszip';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const INCLUDE_DIRS = ['background', 'content', 'shared', 'sidepanel', 'vendor', 'icons'];
const INCLUDE_EXT = /\.(js|html|css|png|json)$/;

const problems = [];
const fail = (msg) => problems.push(msg);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(rel)));
    else if (INCLUDE_EXT.test(entry.name)) out.push(rel);
  }
  return out;
}

const files = ['manifest.json', ...(await Promise.all(INCLUDE_DIRS.map(walk))).flat()].sort();
const has = new Set(files);
const read = (f) => readFile(join(ROOT, f), 'utf8');

// --- manifest ------------------------------------------------------------------

const manifest = JSON.parse(await read('manifest.json'));
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail(`invalid version "${manifest.version}"`);
if (manifest.description.length > 132) fail('manifest description exceeds 132 characters');
if (!manifest.icons?.['128']) fail('manifest needs a 128px icon for the store');

const referenced = [
  manifest.background.service_worker,
  manifest.side_panel.default_path,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
];

// Files the service worker injects at runtime.
const worker = await read(manifest.background.service_worker);
for (const list of worker.matchAll(/const CONTENT_(?:SCRIPTS|CSS) = \[([\s\S]*?)\]/g)) {
  referenced.push(...[...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

// Scripts and styles the side panel page loads.
const panelPath = manifest.side_panel.default_path;
const panelHtml = await read(panelPath);
for (const m of panelHtml.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
  if (/^https?:/.test(m[1])) fail(`${panelPath} loads remote code: ${m[1]}`);
  else referenced.push(join(dirname(panelPath), m[1]));
}

for (const ref of referenced) if (!has.has(ref)) fail(`referenced file missing from package: ${ref}`);

// --- policy checks -------------------------------------------------------------

for (const file of files) {
  if (file.split('/').some((part) => part.startsWith('_'))) fail(`reserved "_" filename: ${file}`);
  if (!file.endsWith('.js')) continue;
  const src = await read(file);
  // MV3 forbids remotely hosted code.
  if (/\bimport\s*(?:[^'"]*from\s*)?['"]https?:/.test(src) || /importScripts\(\s*['"]https?:/.test(src)) {
    fail(`${file} imports remote code`);
  }
}

if (problems.length) {
  console.error(`Package check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

// --- write -----------------------------------------------------------------------

await rm(DIST, { recursive: true, force: true });
const zip = new JSZip();
for (const file of files) {
  const data = await readFile(join(ROOT, file));
  zip.file(file, data, { date: new Date('2020-01-01T00:00:00Z') }); // reproducible
  const out = join(DIST, 'unpacked', file);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, data);
}
const zipPath = join(DIST, `skill-maker-${manifest.version}.zip`);
await writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

const size = (await readFile(zipPath)).length;
console.log(`${relative(ROOT, zipPath)}  (${files.length} files, ${(size / 1024).toFixed(0)} KB)`);
for (const f of files) console.log(`  ${f}`);
