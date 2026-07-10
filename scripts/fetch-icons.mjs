#!/usr/bin/env node
// @ts-check
/**
 * Fetches each listed app's real icon and stores it in the repo.
 * Sources, in order of preference:
 *   1. The app's own web app manifest (largest suitable icon, prefers PNG/WebP)
 *   2. The apple-touch-icon from the page HTML (usually a crisp 180px)
 *
 * Icons are saved to icons/apps/<id>.<ext> and mapped in data/icons.json,
 * which the directory UI loads as optional enrichment (letter tiles remain
 * the fallback). Run by CI weekly alongside the report cards.
 *
 * Usage:
 *   node scripts/fetch-icons.mjs            # fetch icons for apps missing one
 *   node scripts/fetch-icons.mjs --force    # re-fetch all icons
 *   node scripts/fetch-icons.mjs --ids a,b  # fetch specific apps (implies force)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchText, findManifestHref, UA, FETCH_TIMEOUT_MS } from './lib/pwa-facts.mjs';

/** @typedef {{ id: string, name: string, url: string }} App */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons', 'apps');
const MAX_ICON_BYTES = 1_000_000;
const MIN_ICON_BYTES = 100;

/** @type {Record<string, string>} */
const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/gif': 'gif',
};

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
 * Rank a manifest icon: bigger is better (up to 512), PNG/WebP preferred,
 * monochrome icons are near-useless for a directory tile.
 * @param {{ src?: string, sizes?: string, type?: string, purpose?: string }} icon
 */
function iconScore(icon) {
  if (!icon.src) return -1;
  const sizes = String(icon.sizes ?? '').toLowerCase();
  let w = 0;
  if (sizes.includes('any')) {
    w = 512;
  } else {
    for (const s of sizes.split(/\s+/)) {
      const n = parseInt(s, 10);
      if (n > w) w = n;
    }
  }
  let score = Math.min(w, 512);
  const type = String(icon.type ?? '');
  if (/png|webp/.test(type) || /\.(png|webp)(\?|$)/i.test(icon.src)) score += 100;
  if (String(icon.purpose ?? '').includes('monochrome')) score -= 500;
  return score;
}

/**
 * Extract the apple-touch-icon href from page HTML, if present.
 * @param {string} html
 * @returns {string | null}
 */
function findAppleTouchIconHref(html) {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    if (!/rel\s*=\s*["']?[^"'>]*apple-touch-icon/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (href) return href[2] ?? href[3] ?? href[4] ?? null;
  }
  return null;
}

/**
 * Collect candidate icon URLs for an app, best first.
 * @param {App} app
 * @returns {Promise<string[]>}
 */
async function iconCandidates(app) {
  /** @type {string[]} */
  const candidates = [];
  let page;
  try {
    page = await fetchText(app.url);
  } catch {
    return candidates;
  }
  if (!page.ok) return candidates;

  const manifestHref = findManifestHref(page.text);
  if (manifestHref) {
    try {
      const manifestUrl = new URL(manifestHref, page.finalUrl).href;
      const res = await fetchText(manifestUrl);
      if (res.ok) {
        const manifest = JSON.parse(res.text.replace(/^﻿/, ''));
        if (Array.isArray(manifest.icons)) {
          const best = [...manifest.icons].sort((a, b) => iconScore(b) - iconScore(a))[0];
          if (best && iconScore(best) > 0) {
            candidates.push(new URL(best.src, manifestUrl).href);
          }
        }
      }
    } catch { /* bad manifest — fall through to apple-touch-icon */ }
  }

  const appleHref = findAppleTouchIconHref(page.text);
  if (appleHref) {
    try {
      candidates.push(new URL(appleHref, page.finalUrl).href);
    } catch { /* unparseable href — skip */ }
  }

  return candidates;
}

/* --- Run ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('--ids');

const raw = await readFile(join(root, 'data', 'apps.json'), 'utf8');
/** @type {{ apps: App[] }} */
const data = JSON.parse(raw);

/** @type {Record<string, string>} */
let existing = {};
try {
  const iconsRaw = await readFile(join(root, 'data', 'icons.json'), 'utf8');
  existing = JSON.parse(iconsRaw).icons || {};
} catch { /* no icons.json yet — start fresh */ }

let targets = data.apps;
const idsFlag = args.indexOf('--ids');
if (idsFlag !== -1 && args[idsFlag + 1]) {
  const wanted = new Set(args[idsFlag + 1].split(','));
  targets = data.apps.filter((a) => wanted.has(a.id));
} else if (!force) {
  targets = data.apps.filter((a) => !existing[a.id]);
}

// Drop mappings for apps no longer in the directory.
const liveIds = new Set(data.apps.map((a) => a.id));
for (const id of Object.keys(existing)) {
  if (!liveIds.has(id)) delete existing[id];
}

if (targets.length === 0) {
  console.log('All apps already have icons. Use --force to re-fetch.');
} else {
  console.log(`Fetching icons for ${targets.length} app${targets.length === 1 ? '' : 's'}…\n`);
  await mkdir(outDir, { recursive: true });

  for (const app of targets) {
    let saved = false;
    for (const candidate of await iconCandidates(app)) {
      try {
        const img = await fetchBinary(candidate);
        const ext = EXT_BY_TYPE[img.type];
        if (!img.ok || !ext || img.bytes.length < MIN_ICON_BYTES || img.bytes.length > MAX_ICON_BYTES) continue;
        const file = `${app.id}.${ext}`;
        await writeFile(join(outDir, file), img.bytes);
        existing[app.id] = `icons/apps/${file}`;
        console.log(`  ✔ ${app.name} ← ${candidate} (${img.type}, ${(img.bytes.length / 1024).toFixed(0)} KB)`);
        saved = true;
        break;
      } catch { /* try next candidate */ }
    }
    if (!saved) console.log(`  ⚠ ${app.name} — no usable icon found, letter tile stays`);
  }
}

/** @type {Record<string, string>} */
const sorted = {};
for (const id of Object.keys(existing).sort()) sorted[id] = existing[id];

await writeFile(
  join(root, 'data', 'icons.json'),
  JSON.stringify({ generated: new Date().toISOString().slice(0, 10), icons: sorted }, null, 2) + '\n',
  'utf8'
);
console.log(`\n✔ wrote data/icons.json (${Object.keys(sorted).length} icons)`);
