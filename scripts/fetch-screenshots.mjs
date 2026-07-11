#!/usr/bin/env node
// @ts-check
/**
 * Captures a mobile-viewport screenshot of each listed app (roadmap v0.5).
 * Uses the Playwright CLI via npx — a CI/maintainer tool only; the site
 * itself stays dependency-free. Screenshots are stored in screenshots/
 * and mapped in data/screenshots.json, which the UI loads as optional
 * enrichment (the app dialog simply omits the image when absent).
 *
 * Usage:
 *   node scripts/fetch-screenshots.mjs            # capture apps missing one
 *   node scripts/fetch-screenshots.mjs --force    # re-capture all
 *   node scripts/fetch-screenshots.mjs --ids a,b  # capture specific apps
 *
 * Requires Chromium for Playwright (CI installs it):
 *   npx -y playwright@1 install --with-deps chromium
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** @typedef {{ id: string, name: string, url: string }} App */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'screenshots');
const VIEWPORT = '390,780';       // phone-shaped — PWAs are a mobile story
const RENDER_WAIT_MS = '7000';    // let SPAs finish painting
const MAX_BYTES = 2_000_000;

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('--ids');

const raw = await readFile(join(root, 'data', 'apps.json'), 'utf8');
/** @type {{ apps: App[] }} */
const data = JSON.parse(raw);

/** @type {Record<string, string>} */
let existing = {};
try {
  const shotsRaw = await readFile(join(root, 'data', 'screenshots.json'), 'utf8');
  existing = JSON.parse(shotsRaw).screenshots || {};
} catch { /* no screenshots.json yet — start fresh */ }

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
  console.log('All apps already have screenshots. Use --force to re-capture.');
} else {
  console.log(`Capturing ${targets.length} screenshot${targets.length === 1 ? '' : 's'}…\n`);
  await mkdir(outDir, { recursive: true });

  for (const app of targets) {
    const file = `${app.id}.png`;
    const dest = join(outDir, file);
    try {
      // cwd is the repo root and the destination is a relative path: with
      // shell:true (required for npx on Windows) args are joined unquoted,
      // so paths passed here must never contain spaces.
      execFileSync('npx', [
        '-y', 'playwright@1', 'screenshot',
        `--viewport-size=${VIEWPORT}`,
        `--wait-for-timeout=${RENDER_WAIT_MS}`,
        app.url,
        `screenshots/${file}`,
      ], {
        cwd: root,
        stdio: 'pipe',
        timeout: 120_000,
        shell: process.platform === 'win32',
      });
      const { size } = await stat(dest);
      if (size < 1_000 || size > MAX_BYTES) {
        console.log(`  ⚠ ${app.name} — screenshot ${(size / 1024).toFixed(0)} KB out of bounds, skipped`);
        continue;
      }
      existing[app.id] = `screenshots/${file}`;
      console.log(`  ✔ ${app.name} (${(size / 1024).toFixed(0)} KB)`);
    } catch {
      console.log(`  ⚠ ${app.name} — capture failed, dialog will omit the screenshot`);
    }
  }
}

/** @type {Record<string, string>} */
const sorted = {};
for (const id of Object.keys(existing).sort()) sorted[id] = existing[id];

await writeFile(
  join(root, 'data', 'screenshots.json'),
  JSON.stringify({ generated: new Date().toISOString().slice(0, 10), screenshots: sorted }, null, 2) + '\n',
  'utf8'
);
console.log(`\n✔ wrote data/screenshots.json (${Object.keys(sorted).length} screenshots)`);
