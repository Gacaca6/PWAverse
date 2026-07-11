#!/usr/bin/env node
// @ts-check
/**
 * App Store-style preview galleries (roadmap v0.6).
 * Collects up to 4 preview images per app, in order of preference:
 *
 *   1. The app's own manifest `screenshots` array — official, store-grade
 *      previews chosen by the app's developer (narrow/portrait preferred)
 *   2. Headless-browser captures: the landing view plus up to two
 *      scrolled-down views, at a phone viewport (390x780, 2x)
 *
 * Files land in screenshots/<id>-N.<ext>; data/screenshots.json maps
 * id → [paths]. Stale files for delisted apps are pruned. No page
 * interaction is performed — login-walled apps simply show their door.
 *
 * Playwright is a CI/maintainer tool only (the site stays dependency-free).
 * The module is resolved from PLAYWRIGHT_DIR (an npm prefix) or a normal
 * import if installed. CI sets this up in .github/workflows/score-pwas.yml.
 *
 * Usage:
 *   node scripts/fetch-screenshots.mjs            # apps missing previews
 *   node scripts/fetch-screenshots.mjs --force    # re-capture everything
 *   node scripts/fetch-screenshots.mjs --ids a,b  # specific apps (implies force)
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchText, findManifestHref, UA, FETCH_TIMEOUT_MS } from './lib/pwa-facts.mjs';

/** @typedef {{ id: string, name: string, url: string }} App */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'screenshots');
const MAX_SHOTS = 4;
const MAX_SCROLL_SHOTS = 3;
const MAX_IMAGE_BYTES = 2_000_000;
const MIN_IMAGE_BYTES = 1_000;
const VIEWPORT = { width: 390, height: 780 };

/** @type {Record<string, string>} */
const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};

/* --- Playwright resolution (CI/maintainer tool, never shipped) ---------- */

/** @returns {Promise<typeof import('playwright')>} */
async function loadPlaywright() {
  try {
    // @ts-ignore — playwright is not a project dependency by design
    return await import('playwright');
  } catch {
    const prefix = process.env.PLAYWRIGHT_DIR;
    if (!prefix) {
      throw new Error(
        'playwright not found. Install it outside the repo and point PLAYWRIGHT_DIR at it:\n' +
        '  npm install --prefix <dir> playwright\n' +
        '  <dir>/node_modules/.bin/playwright install chromium\n' +
        '  PLAYWRIGHT_DIR=<dir> node scripts/fetch-screenshots.mjs'
      );
    }
    const require = createRequire(import.meta.url);
    return require(join(prefix, 'node_modules', 'playwright'));
  }
}

/* --- Source 1: official screenshots from the app's manifest -------------- */

/**
 * @param {App} app
 * @returns {Promise<{ url: string, type?: string }[]>}
 */
async function manifestScreenshots(app) {
  try {
    const page = await fetchText(app.url);
    if (!page.ok) return [];
    const href = findManifestHref(page.text);
    if (!href) return [];
    const manifestUrl = new URL(href, page.finalUrl).href;
    const res = await fetchText(manifestUrl);
    if (!res.ok) return [];
    const manifest = JSON.parse(res.text.replace(/^﻿/, ''));
    if (!Array.isArray(manifest.screenshots)) return [];

    /** @type {{ src?: string, type?: string, form_factor?: string, sizes?: string }[]} */
    const entries = manifest.screenshots.filter((/** @type {unknown} */ s) => s && typeof (/** @type {{ src?: unknown }} */ (s)).src === 'string');
    // Portrait/narrow first — that's the store look; wide ones fill remaining slots.
    const narrow = entries.filter((s) => s.form_factor !== 'wide');
    const wide = entries.filter((s) => s.form_factor === 'wide');
    return [...narrow, ...wide].slice(0, MAX_SHOTS).map((s) => ({
      url: new URL(/** @type {string} */(s.src), manifestUrl).href,
      type: s.type,
    }));
  } catch {
    return [];
  }
}

/**
 * @param {string} url
 * @returns {Promise<{ ok: boolean, type: string, bytes: Uint8Array }>}
 */
async function fetchBinary(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*' },
  });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array(0);
  return { ok: res.ok, type, bytes };
}

/* --- Source 2: headless scroll-capture ----------------------------------- */

/**
 * @param {import('playwright').Browser} browser
 * @param {App} app
 * @returns {Promise<string[]>} saved repo-relative paths
 */
async function captureScrollShots(browser, app) {
  /** @type {string[]} */
  const saved = [];
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    userAgent: UA,
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    await page.goto(app.url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(6_000); // let SPAs render and fonts settle

    for (let i = 0; i < MAX_SCROLL_SHOTS; i++) {
      const file = `${app.id}-${i + 1}.jpg`;
      await page.screenshot({ path: join(outDir, file), type: 'jpeg', quality: 80 });
      saved.push(`screenshots/${file}`);

      // Scroll one viewport down; stop when there's nothing further to show.
      const canScroll = await page.evaluate(() => {
        const before = window.scrollY;
        window.scrollBy(0, window.innerHeight * 0.92);
        return window.scrollY > before + 40;
      });
      if (!canScroll) break;
      await page.waitForTimeout(1_200);
    }
  } finally {
    await context.close();
  }
  return saved;
}

/* --- Run ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('--ids');

const raw = await readFile(join(root, 'data', 'apps.json'), 'utf8');
/** @type {{ apps: App[] }} */
const data = JSON.parse(raw);

/** @type {Record<string, string[]>} */
let existing = {};
try {
  const shotsRaw = await readFile(join(root, 'data', 'screenshots.json'), 'utf8');
  const parsed = JSON.parse(shotsRaw).screenshots || {};
  // Migrate v0.5 single-string entries to arrays.
  for (const [id, val] of Object.entries(parsed)) {
    existing[id] = Array.isArray(val) ? val : [val];
  }
} catch { /* no screenshots.json yet — start fresh */ }

let targets = data.apps;
const idsFlag = args.indexOf('--ids');
if (idsFlag !== -1 && args[idsFlag + 1]) {
  const wanted = new Set(args[idsFlag + 1].split(','));
  targets = data.apps.filter((a) => wanted.has(a.id));
} else if (!force) {
  targets = data.apps.filter((a) => !existing[a.id] || existing[a.id].length === 0);
}

// Drop mappings for apps no longer in the directory.
const liveIds = new Set(data.apps.map((a) => a.id));
for (const id of Object.keys(existing)) {
  if (!liveIds.has(id)) delete existing[id];
}

if (targets.length === 0) {
  console.log('All apps already have previews. Use --force to re-capture.');
} else {
  console.log(`Building previews for ${targets.length} app${targets.length === 1 ? '' : 's'}…\n`);
  await mkdir(outDir, { recursive: true });
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch();

  for (const app of targets) {
    /** @type {string[]} */
    let shots = [];

    // Official manifest screenshots win outright when present.
    const official = await manifestScreenshots(app);
    for (const [i, entry] of official.entries()) {
      try {
        const img = await fetchBinary(entry.url);
        const ext = EXT_BY_TYPE[img.type];
        if (!img.ok || !ext || img.bytes.length < MIN_IMAGE_BYTES || img.bytes.length > MAX_IMAGE_BYTES) continue;
        const file = `${app.id}-${i + 1}.${ext}`;
        await writeFile(join(outDir, file), img.bytes);
        shots.push(`screenshots/${file}`);
      } catch { /* skip this one */ }
    }
    const source = shots.length > 0 ? 'official manifest screenshots' : 'captured';

    if (shots.length === 0) {
      try {
        shots = await captureScrollShots(browser, app);
      } catch { /* page refused to render headlessly */ }
    }

    if (shots.length > 0) {
      existing[app.id] = shots;
      console.log(`  ✔ ${app.name} — ${shots.length} preview${shots.length === 1 ? '' : 's'} (${source})`);
    } else {
      delete existing[app.id];
      console.log(`  ⚠ ${app.name} — no previews possible, page will omit the gallery`);
    }
  }

  await browser.close();
}

/* --- Write map and prune stale files -------------------------------------- */

/** @type {Record<string, string[]>} */
const sorted = {};
for (const id of Object.keys(existing).sort()) sorted[id] = existing[id];

await writeFile(
  join(root, 'data', 'screenshots.json'),
  JSON.stringify({ generated: new Date().toISOString().slice(0, 10), screenshots: sorted }, null, 2) + '\n',
  'utf8'
);

const referenced = new Set(Object.values(sorted).flat().map((p) => p.replace('screenshots/', '')));
try {
  for (const file of await readdir(outDir)) {
    if (!referenced.has(file)) await unlink(join(outDir, file));
  }
} catch { /* screenshots dir may not exist when nothing captured */ }

const total = Object.values(sorted).flat().length;
console.log(`\n✔ wrote data/screenshots.json (${Object.keys(sorted).length} apps, ${total} previews)`);
