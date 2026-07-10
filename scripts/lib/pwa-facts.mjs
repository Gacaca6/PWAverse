// @ts-check
/**
 * Shared fact-gathering for PWA checks (used by check-pwas.mjs and
 * score-pwas.mjs). Visits an app's URL and records what a crawler can
 * honestly observe — no judgments here, just facts. The consumers decide
 * what counts as a failure (check-pwas) or a grade (score-pwas).
 *
 * Zero dependencies — plain Node 18+ (uses global fetch).
 */

export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_SCRIPTS_TO_SCAN = 8;
export const MAX_SCRIPT_BYTES = 1_000_000;
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 PWAverseBot/1.0 (+https://github.com/Gacaca6/PWAverse)';
export const BLOCKED_STATUSES = new Set([401, 403, 405, 429, 503]);

/**
 * What we learned about an app's manifest.
 * @typedef {Object} ManifestFacts
 * @property {'linked' | 'missing'} link
 * @property {string} [url]
 * @property {boolean} parses
 * @property {boolean} hasName
 * @property {boolean} hasStart
 * @property {boolean} appDisplay
 * @property {string} [display]
 * @property {boolean} icon192
 * @property {string} [error]
 */

/**
 * Everything a static crawl can honestly observe about an app.
 * @typedef {Object} PwaFacts
 * @property {boolean} reachable
 * @property {boolean} blocked  bot-wall: blocked status code or challenge page
 * @property {number} status
 * @property {string} [error]   network-level failure (DNS, TLS, timeout)
 * @property {ManifestFacts} manifest
 * @property {boolean} swDetected
 * @property {boolean} appleTouchIcon
 * @property {boolean} themeColor
 */

/**
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status: number, finalUrl: string, text: string }>}
 */
export async function fetchText(url) {
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
export function findManifestHref(html) {
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
export function findScriptUrls(html, baseUrl) {
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
export function hasInstallableIcon(icons) {
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
 * Visit an app and record everything observable.
 * @param {{ url: string }} app
 * @returns {Promise<PwaFacts>}
 */
export async function gatherFacts(app) {
  /** @type {PwaFacts} */
  const facts = {
    reachable: false,
    blocked: false,
    status: 0,
    manifest: { link: 'missing', parses: false, hasName: false, hasStart: false, appDisplay: false, icon192: false },
    swDetected: false,
    appleTouchIcon: false,
    themeColor: false,
  };

  let page;
  try {
    page = await fetchText(app.url);
  } catch (err) {
    facts.error = err instanceof Error ? err.message : String(err);
    return facts;
  }

  facts.status = page.status;
  if (!page.ok) {
    facts.blocked = BLOCKED_STATUSES.has(page.status);
    return facts;
  }
  facts.reachable = true;

  // Some bot-walls return 200 with a challenge page — don't judge those.
  if (/captcha|cf-challenge|just a moment|attention required/i.test(page.text.slice(0, 4000))) {
    facts.blocked = true;
    return facts;
  }

  // --- iOS friendliness signals (visible in plain HTML) ---
  facts.appleTouchIcon = /<link\b[^>]*rel\s*=\s*["']?[^"'>]*apple-touch-icon/i.test(page.text);
  facts.themeColor = /<meta\b[^>]*name\s*=\s*["']?theme-color/i.test(page.text);

  // --- Service worker (heuristic: registration code is often in bundles) ---
  facts.swDetected = /serviceWorker/.test(page.text);
  if (!facts.swDetected) {
    for (const scriptUrl of findScriptUrls(page.text, page.finalUrl)) {
      try {
        const script = await fetchText(scriptUrl);
        if (script.ok && script.text.slice(0, MAX_SCRIPT_BYTES).includes('serviceWorker')) {
          facts.swDetected = true;
          break;
        }
      } catch { /* script fetch failed — keep scanning others */ }
    }
  }

  // --- Manifest ---
  const href = findManifestHref(page.text);
  if (href) {
    facts.manifest.link = 'linked';
    try {
      const manifestUrl = new URL(href, page.finalUrl).href;
      facts.manifest.url = manifestUrl;
      const res = await fetchText(manifestUrl);
      if (!res.ok) {
        facts.manifest.error = `manifest at ${manifestUrl} returned HTTP ${res.status}`;
      } else {
        const manifest = JSON.parse(res.text.replace(/^﻿/, ''));
        facts.manifest.parses = true;
        facts.manifest.hasName = Boolean(manifest.name || manifest.short_name);
        facts.manifest.hasStart = Boolean(manifest.start_url || manifest.scope);
        facts.manifest.display = manifest.display;
        facts.manifest.appDisplay = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].includes(manifest.display);
        facts.manifest.icon192 = hasInstallableIcon(manifest.icons);
      }
    } catch (err) {
      facts.manifest.error = `manifest error: ${err instanceof Error ? err.message : err}`;
    }
  }

  return facts;
}
