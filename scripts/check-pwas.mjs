#!/usr/bin/env node
// @ts-check
/**
 * PWA quality checks (roadmap v0.3).
 * Visits each app in data/apps.json and verifies it behaves like a PWA:
 *
 *   1. The URL is reachable over HTTPS
 *   2. The page links a web app manifest, and the manifest parses with
 *      a name, a start_url/scope, an app-like display mode, and an
 *      icon of at least 192px
 *   3. A service worker registration is detectable (heuristic)
 *
 * Zero dependencies — plain Node 18+ (uses global fetch).
 *
 * Usage:
 *   node scripts/check-pwas.mjs                  # check every app
 *   node scripts/check-pwas.mjs --ids a,b        # check specific apps
 *   node scripts/check-pwas.mjs --diff <gitref>  # only apps added/changed vs ref
 *
 * Severity model (kept honest about what a crawler can and can't know):
 *   FAIL — unreachable, or reachable but no manifest at all
 *   WARN — bot-blocked (401/403/429/challenge), manifest weaknesses,
 *          or no service worker found by heuristic (bundlers hide them)
 *   CI exits 1 only on FAIL.
 */

import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** @typedef {{ id: string, name: string, url: string }} App */
/** @typedef {{ level: 'pass' | 'warn' | 'fail', msg: string }} Finding */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FETCH_TIMEOUT_MS = 20_000;
const MAX_SCRIPTS_TO_SCAN = 8;
const MAX_SCRIPT_BYTES = 1_000_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 PWAverseBot/1.0 (+https://github.com/Gacaca6/PWAverse)';
const BLOCKED_STATUSES = new Set([401, 403, 405, 429, 503]);

/**
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status: number, finalUrl: string, text: string }>}
 */
async function fetchText(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/manifest+json,application/json,*/*' },
  });
  const text = res.ok ? await res.text() : '';
  return { ok: res.ok, status: res.status, finalUrl: res.url || url, text };
}

/**
 * Extract the manifest href from an HTML document, if present.
 * @param {string} html
 * @returns {string | null}
 */
function findManifestHref(html) {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    if (!/rel\s*=\s*["']?[^"'>]*manifest/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (href) return href[2] ?? href[3] ?? href[4] ?? null;
  }
  return null;
}

/**
 * Extract same-origin script URLs from an HTML document.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string[]}
 */
function findScriptUrls(html, baseUrl) {
  const urls = [];
  const scriptTags = html.match(/<script\b[^>]*src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi) || [];
  for (const tag of scriptTags) {
    const m = tag.match(/src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const src = m && (m[2] ?? m[3] ?? m[4]);
    if (!src) continue;
    try {
      const resolved = new URL(src, baseUrl);
      if (resolved.origin === new URL(baseUrl).origin) urls.push(resolved.href);
    } catch { /* unparseable src — skip */ }
  }
  return urls.slice(0, MAX_SCRIPTS_TO_SCAN);
}

/** @param {unknown} icons */
function hasInstallableIcon(icons) {
  if (!Array.isArray(icons)) return false;
  return icons.some((icon) => {
    const sizes = String(icon?.sizes ?? '').toLowerCase();
    if (sizes.includes('any')) return true;
    return sizes.split(/\s+/).some((s) => {
      const [w] = s.split('x').map(Number);
      return w >= 192;
    });
  });
}

/**
 * @param {App} app
 * @returns {Promise<Finding[]>}
 */
async function checkApp(app) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {{ ok: boolean, status: number, finalUrl: string, text: string }} */
  let page;

  try {
    page = await fetchText(app.url);
  } catch (err) {
    findings.push({ level: 'fail', msg: `unreachable: ${err instanceof Error ? err.message : err}` });
    return findings;
  }

  if (!page.ok) {
    if (BLOCKED_STATUSES.has(page.status)) {
      findings.push({ level: 'warn', msg: `HTTP ${page.status} — site blocks automated checks, verify manually in a browser` });
      return findings;
    }
    findings.push({ level: 'fail', msg: `HTTP ${page.status} fetching ${app.url}` });
    return findings;
  }
  findings.push({ level: 'pass', msg: `reachable (HTTP ${page.status})` });

  // Some bot-walls return 200 with a challenge page — don't judge those.
  if (/captcha|cf-challenge|just a moment|attention required/i.test(page.text.slice(0, 4000))) {
    findings.push({ level: 'warn', msg: 'looks like a bot challenge page — verify manually in a browser' });
    return findings;
  }

  // --- Service worker (heuristic: registration code is often in bundles) ---
  let swFound = /serviceWorker/.test(page.text);
  if (!swFound) {
    for (const scriptUrl of findScriptUrls(page.text, page.finalUrl)) {
      try {
        const script = await fetchText(scriptUrl);
        if (script.ok && script.text.slice(0, MAX_SCRIPT_BYTES).includes('serviceWorker')) {
          swFound = true;
          break;
        }
      } catch { /* script fetch failed — keep scanning others */ }
    }
  }

  // --- Manifest ---
  const manifestHref = findManifestHref(page.text);
  if (!manifestHref) {
    // SPAs (e.g. vscode.dev) inject the manifest with JavaScript, invisible to a
    // static scan. A detected service worker is strong evidence it's a real PWA,
    // so only hard-fail when both signals are missing.
    findings.push(swFound
      ? { level: 'warn', msg: 'no <link rel="manifest"> in static HTML — likely injected by JavaScript; verify manually' }
      : { level: 'fail', msg: 'no <link rel="manifest"> found in the page HTML' });
  } else {
    try {
      const manifestUrl = new URL(manifestHref, page.finalUrl).href;
      const manifestRes = await fetchText(manifestUrl);
      if (!manifestRes.ok) {
        findings.push({ level: 'fail', msg: `manifest at ${manifestUrl} returned HTTP ${manifestRes.status}` });
      } else {
        const manifest = JSON.parse(manifestRes.text.replace(/^﻿/, ''));
        findings.push({ level: 'pass', msg: 'manifest found and parses as JSON' });

        if (!manifest.name && !manifest.short_name) {
          findings.push({ level: 'warn', msg: 'manifest has no name/short_name' });
        }
        if (!manifest.start_url && !manifest.scope) {
          findings.push({ level: 'warn', msg: 'manifest has no start_url or scope' });
        }
        if (!['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].includes(manifest.display)) {
          findings.push({ level: 'warn', msg: `manifest display is "${manifest.display ?? 'unset'}" — app won't open in its own window` });
        }
        if (!hasInstallableIcon(manifest.icons)) {
          findings.push({ level: 'warn', msg: 'manifest has no icon of at least 192px — not installable on Android' });
        }
      }
    } catch (err) {
      findings.push({ level: 'fail', msg: `manifest error: ${err instanceof Error ? err.message : err}` });
    }
  }

  findings.push(swFound
    ? { level: 'pass', msg: 'service worker registration detected' }
    : { level: 'warn', msg: 'no service worker detected (may be hidden in bundled/lazy code) — verify in DevTools' });

  return findings;
}

/* --- Select which apps to check ---------------------------------------- */

/** @returns {Promise<App[]>} */
async function selectApps() {
  const raw = await readFile(join(root, 'data', 'apps.json'), 'utf8');
  /** @type {{ apps: App[] }} */
  const data = JSON.parse(raw);
  const args = process.argv.slice(2);

  const idsFlag = args.indexOf('--ids');
  if (idsFlag !== -1 && args[idsFlag + 1]) {
    const wanted = new Set(args[idsFlag + 1].split(','));
    return data.apps.filter((a) => wanted.has(a.id));
  }

  const diffFlag = args.indexOf('--diff');
  if (diffFlag !== -1 && args[diffFlag + 1]) {
    const ref = args[diffFlag + 1];
    /** @type {Map<string, string>} */
    let baseById = new Map();
    try {
      const baseRaw = execSync(`git show ${ref}:data/apps.json`, { cwd: root, encoding: 'utf8' });
      /** @type {{ apps: App[] }} */
      const base = JSON.parse(baseRaw);
      baseById = new Map(base.apps.map((a) => [a.id, JSON.stringify(a)]));
    } catch {
      console.log(`(could not read data/apps.json at ${ref} — checking all apps)`);
      return data.apps;
    }
    return data.apps.filter((a) => baseById.get(a.id) !== JSON.stringify(a));
  }

  return data.apps;
}

/* --- Run ------------------------------------------------------------------ */

const apps = await selectApps();
if (apps.length === 0) {
  console.log('No apps to check (no additions/changes detected).');
  process.exit(0);
}

console.log(`Checking ${apps.length} app${apps.length === 1 ? '' : 's'}…\n`);

const ICONS = { pass: '✔', warn: '⚠', fail: '✖' };
let failures = 0;
let warnings = 0;

for (const app of apps) {
  const findings = await checkApp(app);
  const worst = findings.some((f) => f.level === 'fail') ? 'fail'
    : findings.some((f) => f.level === 'warn') ? 'warn' : 'pass';
  if (worst === 'fail') failures++;
  if (worst === 'warn') warnings++;

  console.log(`${ICONS[worst]} ${app.name} (${app.url})`);
  for (const f of findings) console.log(`    ${ICONS[f.level]} ${f.msg}`);
  console.log('');
}

console.log('—'.repeat(50));
console.log(`${apps.length} checked · ${apps.length - failures - warnings} clean · ${warnings} with warnings · ${failures} failed`);

if (failures > 0) {
  console.error('\nSome apps failed PWA checks. See findings above — a maintainer should verify manually before merging.');
  process.exit(1);
}
