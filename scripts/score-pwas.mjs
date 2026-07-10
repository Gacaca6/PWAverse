#!/usr/bin/env node
// @ts-check
/**
 * PWA report cards (roadmap v0.4).
 * Visits every app in data/apps.json, gathers facts (lib/pwa-facts.mjs),
 * and writes per-app scores to data/scores.json for the directory UI.
 *
 * Dimensions — each rated good | ok | poor | unknown:
 *   installability — manifest quality (name, start_url, display, 192px icon)
 *   offline        — service worker detected (a heuristic can prove presence,
 *                    never absence, so "not found" scores unknown, not poor)
 *   ios            — apple-touch-icon + theme-color in the page HTML
 *
 * Overall grade:
 *   A — strong manifest AND service worker detected
 *   B — one strong signal (installable manifest OR service worker)
 *   C — reachable but weak PWA signals
 *   ? — couldn't verify (site blocks robots or is unreachable)
 *
 * Usage:
 *   node scripts/score-pwas.mjs          # score all apps, write data/scores.json
 *   node scripts/score-pwas.mjs --dry    # print scores without writing
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gatherFacts } from './lib/pwa-facts.mjs';

/** @typedef {{ id: string, name: string, url: string }} App */
/** @typedef {'good' | 'ok' | 'poor' | 'unknown'} Dim */
/** @typedef {{ installability: Dim, offline: Dim, ios: Dim, grade: 'A' | 'B' | 'C' | '?', checked: string }} Score */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const today = new Date().toISOString().slice(0, 10);

/**
 * @param {import('./lib/pwa-facts.mjs').PwaFacts} facts
 * @returns {Score}
 */
function scoreFacts(facts) {
  const unverified = !facts.reachable || facts.blocked;
  if (unverified) {
    return { installability: 'unknown', offline: 'unknown', ios: 'unknown', grade: '?', checked: today };
  }

  const m = facts.manifest;
  /** @type {Dim} */
  let installability;
  if (m.parses && m.hasName && m.hasStart && m.appDisplay && m.icon192) {
    installability = 'good';
  } else if (m.parses) {
    installability = 'ok';
  } else if (m.link === 'missing' && facts.swDetected) {
    installability = 'unknown'; // manifest likely injected by JS — can't judge it
  } else {
    installability = 'poor';
  }

  /** @type {Dim} */
  const offline = facts.swDetected ? 'good' : 'unknown';

  /** @type {Dim} */
  const ios = facts.appleTouchIcon && facts.themeColor ? 'good'
    : facts.appleTouchIcon || facts.themeColor ? 'ok'
    : 'poor';

  /** @type {Score['grade']} */
  const grade = installability === 'good' && offline === 'good' ? 'A'
    : installability === 'good' || offline === 'good' ? 'B'
    : 'C';

  return { installability, offline, ios, grade, checked: today };
}

/* --- Run ------------------------------------------------------------------ */

const dry = process.argv.includes('--dry');
const raw = await readFile(join(root, 'data', 'apps.json'), 'utf8');
/** @type {{ apps: App[] }} */
const data = JSON.parse(raw);

console.log(`Scoring ${data.apps.length} apps…\n`);

/** @type {Record<string, Score>} */
const scores = {};
for (const app of data.apps) {
  const facts = await gatherFacts(app);
  const score = scoreFacts(facts);
  scores[app.id] = score;
  console.log(`  ${score.grade === '?' ? '?' : score.grade} — ${app.name}  (install: ${score.installability}, offline: ${score.offline}, ios: ${score.ios})`);
}

// Sort keys so re-runs produce stable, reviewable diffs.
/** @type {Record<string, Score>} */
const sorted = {};
for (const id of Object.keys(scores).sort()) sorted[id] = scores[id];

const out = { generated: today, scores: sorted };

if (dry) {
  console.log('\n(--dry: not writing data/scores.json)');
} else {
  await writeFile(join(root, 'data', 'scores.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('\n✔ wrote data/scores.json');
}
