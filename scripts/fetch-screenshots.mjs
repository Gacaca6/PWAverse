#!/usr/bin/env node
// @ts-check
/**
 * App Store-style preview galleries (v0.6, richer previews v0.7).
 * Builds up to 5 preview images per app:
 *
 *   1. LAUNCH SCREEN — synthesized exactly the way Android builds a PWA
 *      splash: manifest background_color + app icon + name. Every app
 *      gets one, so every gallery opens like a real install preview.
 *   2. Official manifest `screenshots` — store-grade previews chosen by
 *      the app's developer (narrow/portrait first). These win outright.
 *   3. Otherwise: landing capture, up to two scrolled views, and up to
 *      a few IN-APP screens found by following the app's own same-origin
 *      navigation links (plain page visits only — never login, checkout,
 *      download, or account links; no buttons are ever clicked).
 *
 * Files land in screenshots/<id>-*.ext; data/screenshots.json maps
 * id → [paths]. Stale files are pruned. Near-duplicate and blank
 * captures are discarded.
 *
 * Playwright is a CI/maintainer tool only (the site stays dependency-free),
 * resolved via PLAYWRIGHT_DIR (an npm prefix) or a normal import.
 *
 * Usage:
 *   node scripts/fetch-screenshots.mjs            # apps missing previews
 *   node scripts/fetch-screenshots.mjs --force    # rebuild everything
 *   node scripts/fetch-screenshots.mjs --ids a,b  # specific apps (implies force)
 */

import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { fetchText, findManifestHref, UA, FETCH_TIMEOUT_MS } from './lib/pwa-facts.mjs';

/** @typedef {{ id: string, name: string, url: string, iconLetter: string, iconColor: string }} App */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'screenshots');
const MAX_CAPTURES = 4;          // besides the splash
const MAX_SCROLL_SHOTS = 3;
const MAX_ROUTE_SHOTS = 3;
const MAX_IMAGE_BYTES = 2_000_000;
const MIN_IMAGE_BYTES = 6_000;   // smaller jpegs are blank/near-blank pages
const VIEWPORT = { width: 390, height: 780 };
const UNSAFE_LINK = /login|signin|sign-in|signup|sign-up|auth|logout|account|profile|checkout|cart|pay|billing|subscribe|register|download|\.(pdf|zip|dmg|exe|apk)(\?|$)|mailto:|tel:/i;

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

/* --- Per-app context: page HTML + parsed manifest -------------------------- */

/**
 * @param {App} app
 * @returns {Promise<{ html: string, finalUrl: string, manifest: any, manifestUrl: string | null }>}
 */
async function previewContext(app) {
  const ctx = { html: '', finalUrl: app.url, manifest: /** @type {any} */ (null), manifestUrl: /** @type {string | null} */ (null) };
  try {
    const page = await fetchText(app.url);
    if (!page.ok) return ctx;
    ctx.html = page.text;
    ctx.finalUrl = page.finalUrl;
    const href = findManifestHref(page.text);
    if (href) {
      ctx.manifestUrl = new URL(href, page.finalUrl).href;
      const res = await fetchText(ctx.manifestUrl);
      if (res.ok) ctx.manifest = JSON.parse(res.text.replace(/^﻿/, ''));
    }
  } catch { /* unreachable or bad manifest — captures may still work */ }
  return ctx;
}

/* --- Shot 1: synthesized launch (splash) screen ----------------------------- */

/** @param {string} hex */
function isLight(hex) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 140;
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render the app's OS-style launch screen: manifest background_color,
 * the icon we self-host, and the app name — same recipe Android uses.
 * @param {import('playwright').Browser} browser
 * @param {App} app
 * @param {any} manifest
 * @param {Record<string, string>} iconMap
 * @returns {Promise<string | null>} saved repo-relative path
 */
async function buildSplash(browser, app, manifest, iconMap) {
  let bg = typeof manifest?.background_color === 'string' ? manifest.background_color.trim() : '';
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(bg)) bg = '#0f1117';
  const fg = isLight(bg) ? '#16181f' : '#f4f5fa';

  let iconHtml;
  const iconPath = iconMap[app.id];
  if (iconPath) {
    const bytes = await readFile(join(root, iconPath));
    const ext = extname(iconPath).slice(1);
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    iconHtml = `<img src="data:${mime};base64,${bytes.toString('base64')}" style="width:104px;height:104px;border-radius:24px;object-fit:cover" alt="">`;
  } else {
    iconHtml = `<div style="width:104px;height:104px;border-radius:24px;background:${app.iconColor};display:grid;place-items:center;color:#fff;font:700 48px system-ui">${escapeHtml(app.iconLetter)}</div>`;
  }

  const name = escapeHtml(typeof manifest?.name === 'string' && manifest.name ? manifest.name : app.name);
  const html = `<!doctype html><body style="margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;display:grid;place-items:center;background:${bg}">
    <div style="text-align:center;font-family:system-ui">
      <div style="display:inline-block">${iconHtml}</div>
      <p style="margin:18px 0 0;font:600 17px system-ui;color:${fg}">${name}</p>
    </div></body>`;

  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const file = `${app.id}-splash.jpg`;
    await page.screenshot({ path: join(outDir, file), type: 'jpeg', quality: 88 });
    return `screenshots/${file}`;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

/* --- Shots 2..n: official manifest screenshots ------------------------------ */

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

/**
 * @param {App} app
 * @param {any} manifest
 * @param {string | null} manifestUrl
 * @returns {Promise<string[]>}
 */
async function officialScreenshots(app, manifest, manifestUrl) {
  /** @type {string[]} */
  const saved = [];
  if (!manifestUrl || !Array.isArray(manifest?.screenshots)) return saved;

  /** @type {{ src?: string, form_factor?: string }[]} */
  const entries = manifest.screenshots.filter((/** @type {unknown} */ s) => s && typeof (/** @type {{ src?: unknown }} */ (s)).src === 'string');
  const narrow = entries.filter((s) => s.form_factor !== 'wide');
  const wide = entries.filter((s) => s.form_factor === 'wide');

  for (const [i, entry] of [...narrow, ...wide].slice(0, MAX_CAPTURES).entries()) {
    try {
      const url = new URL(/** @type {string} */(entry.src), manifestUrl).href;
      const img = await fetchBinary(url);
      const ext = EXT_BY_TYPE[img.type];
      if (!img.ok || !ext || img.bytes.length < 1_000 || img.bytes.length > MAX_IMAGE_BYTES) continue;
      const file = `${app.id}-${i + 1}.${ext}`;
      await writeFile(join(outDir, file), img.bytes);
      saved.push(`screenshots/${file}`);
    } catch { /* skip this one */ }
  }
  return saved;
}

/* --- Fallback: landing + scrolled views + safe in-app routes ---------------- */

/**
 * Same-origin navigation links from the landing page — plain content pages
 * only, never auth/commerce/download links.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string[]}
 */
function safeRouteLinks(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const basePath = new URL(baseUrl).pathname;
  /** @type {Map<string, string>} */
  const routes = new Map();
  for (const tag of html.match(/<a\b[^>]*href\s*=\s*("[^"]*"|'[^']*')[^>]*>/gi) || []) {
    const m = tag.match(/href\s*=\s*("([^"]*)"|'([^']*)')/i);
    const href = m && (m[2] ?? m[3]);
    if (!href || href.startsWith('#') || UNSAFE_LINK.test(href)) continue;
    try {
      const u = new URL(href, baseUrl);
      if (u.origin !== origin || u.pathname === basePath || u.pathname === '/') continue;
      if (UNSAFE_LINK.test(u.pathname)) continue;
      if (!routes.has(u.pathname)) routes.set(u.pathname, u.href.split('#')[0]);
    } catch { /* unparseable href */ }
  }
  return [...routes.values()].slice(0, MAX_ROUTE_SHOTS);
}

/**
 * @param {import('playwright').Browser} browser
 * @param {App} app
 * @param {string[]} routeLinks
 * @returns {Promise<string[]>}
 */
async function captureShots(browser, app, routeLinks) {
  /** @type {string[]} */
  const saved = [];
  /** @type {number[]} */
  const sizes = [];
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    userAgent: UA,
    reducedMotion: 'reduce',
  });

  /**
   * @param {import('playwright').Page} page
   * @param {number} n
   */
  const snap = async (page, n) => {
    const file = `${app.id}-${n}.jpg`;
    const path = join(outDir, file);
    await page.screenshot({ path, type: 'jpeg', quality: 80 });
    const { size } = await stat(path);
    // Discard blank pages and near-duplicates of earlier shots.
    if (size < MIN_IMAGE_BYTES || sizes.some((s) => Math.abs(s - size) / s < 0.03)) {
      await unlink(path);
      return false;
    }
    sizes.push(size);
    saved.push(`screenshots/${file}`);
    return true;
  };

  try {
    const page = await context.newPage();
    await page.goto(app.url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(6_000);

    let n = 1;
    for (let i = 0; i < MAX_SCROLL_SHOTS && saved.length < MAX_CAPTURES; i++) {
      if (await snap(page, n)) n++;
      const canScroll = await page.evaluate(() => {
        const before = window.scrollY;
        window.scrollBy(0, window.innerHeight * 0.92);
        return window.scrollY > before + 40;
      });
      if (!canScroll) break;
      await page.waitForTimeout(1_200);
    }

    // In-app screens via the app's own navigation links (plain GETs only).
    for (const link of routeLinks) {
      if (saved.length >= MAX_CAPTURES) break;
      try {
        await page.goto(link, { waitUntil: 'load', timeout: 20_000 });
        if (new URL(page.url()).origin !== new URL(app.url).origin) continue;
        await page.waitForTimeout(3_500);
        if (await snap(page, n)) n++;
      } catch { /* route refused to render — keep going */ }
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

/** @type {Record<string, string>} */
let iconMap = {};
try {
  iconMap = JSON.parse(await readFile(join(root, 'data', 'icons.json'), 'utf8')).icons || {};
} catch { /* no icons yet — splash falls back to letter tiles */ }

/** @type {Record<string, string[]>} */
let existing = {};
try {
  const parsed = JSON.parse(await readFile(join(root, 'data', 'screenshots.json'), 'utf8')).screenshots || {};
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

const liveIds = new Set(data.apps.map((a) => a.id));
for (const id of Object.keys(existing)) {
  if (!liveIds.has(id)) delete existing[id];
}

if (targets.length === 0) {
  console.log('All apps already have previews. Use --force to rebuild.');
} else {
  console.log(`Building previews for ${targets.length} app${targets.length === 1 ? '' : 's'}…\n`);
  await mkdir(outDir, { recursive: true });
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch();

  for (const app of targets) {
    const ctx = await previewContext(app);
    /** @type {string[]} */
    const shots = [];

    const splash = await buildSplash(browser, app, ctx.manifest, iconMap);
    if (splash) shots.push(splash);

    const official = await officialScreenshots(app, ctx.manifest, ctx.manifestUrl);
    let source;
    if (official.length > 0) {
      shots.push(...official);
      source = `splash + ${official.length} official`;
    } else {
      const routes = ctx.html ? safeRouteLinks(ctx.html, ctx.finalUrl) : [];
      /** @type {string[]} */
      let captured = [];
      try {
        captured = await captureShots(browser, app, routes);
      } catch { /* page refused to render headlessly */ }
      shots.push(...captured);
      source = `splash + ${captured.length} captured${routes.length ? ` (${routes.length} routes tried)` : ''}`;
    }

    if (shots.length > 0) {
      existing[app.id] = shots;
      console.log(`  ✔ ${app.name} — ${shots.length} previews (${source})`);
    } else {
      delete existing[app.id];
      console.log(`  ⚠ ${app.name} — no previews possible`);
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
