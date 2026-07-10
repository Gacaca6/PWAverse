#!/usr/bin/env node
// @ts-check
/**
 * PWA quality checks (roadmap v0.3).
 * Visits each app in data/apps.json and verifies it behaves like a PWA.
 * Fact-gathering lives in lib/pwa-facts.mjs (shared with score-pwas.mjs);
 * this script turns facts into pass/warn/fail findings for CI.
 *
 * Usage:
 *   node scripts/check-pwas.mjs                  # check every app
 *   node scripts/check-pwas.mjs --ids a,b        # check specific apps
 *   node scripts/check-pwas.mjs --diff <gitref>  # only apps added/changed vs ref
 *
 * Severity model (kept honest about what a crawler can and can't know):
 *   FAIL — unreachable, or reachable but no manifest and no service worker
 *   WARN — bot-blocked (401/403/429/challenge), manifest weaknesses,
 *          or no service worker found by heuristic (bundlers hide them)
 *   CI exits 1 only on FAIL.
 */

import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gatherFacts } from './lib/pwa-facts.mjs';

/** @typedef {{ id: string, name: string, url: string }} App */
/** @typedef {{ level: 'pass' | 'warn' | 'fail', msg: string }} Finding */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {App} app
 * @returns {Promise<Finding[]>}
 */
async function checkApp(app) {
  /** @type {Finding[]} */
  const findings = [];
  const facts = await gatherFacts(app);

  if (facts.error) {
    findings.push({ level: 'fail', msg: `unreachable: ${facts.error}` });
    return findings;
  }
  if (!facts.reachable) {
    findings.push(facts.blocked
      ? { level: 'warn', msg: `HTTP ${facts.status} — site blocks automated checks, verify manually in a browser` }
      : { level: 'fail', msg: `HTTP ${facts.status} fetching ${app.url}` });
    return findings;
  }
  findings.push({ level: 'pass', msg: `reachable (HTTP ${facts.status})` });

  if (facts.blocked) {
    findings.push({ level: 'warn', msg: 'looks like a bot challenge page — verify manually in a browser' });
    return findings;
  }

  // --- Manifest ---
  const m = facts.manifest;
  if (m.link === 'missing') {
    // SPAs (e.g. vscode.dev) inject the manifest with JavaScript, invisible to a
    // static scan. A detected service worker is strong evidence it's a real PWA,
    // so only hard-fail when both signals are missing.
    findings.push(facts.swDetected
      ? { level: 'warn', msg: 'no <link rel="manifest"> in static HTML — likely injected by JavaScript; verify manually' }
      : { level: 'fail', msg: 'no <link rel="manifest"> found in the page HTML' });
  } else if (m.error) {
    findings.push({ level: 'fail', msg: m.error });
  } else if (m.parses) {
    findings.push({ level: 'pass', msg: 'manifest found and parses as JSON' });
    if (!m.hasName) findings.push({ level: 'warn', msg: 'manifest has no name/short_name' });
    if (!m.hasStart) findings.push({ level: 'warn', msg: 'manifest has no start_url or scope' });
    if (!m.appDisplay) findings.push({ level: 'warn', msg: `manifest display is "${m.display ?? 'unset'}" — app won't open in its own window` });
    if (!m.icon192) findings.push({ level: 'warn', msg: 'manifest has no icon of at least 192px — not installable on Android' });
  }

  // --- Service worker ---
  findings.push(facts.swDetected
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
