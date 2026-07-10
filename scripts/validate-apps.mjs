#!/usr/bin/env node
// @ts-check
/**
 * Validates data/apps.json against the directory rules.
 * Zero dependencies — runs with plain Node 18+.
 * Used by CI on every push/PR and available locally:
 *
 *   node scripts/validate-apps.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** @type {string[]} */
const errors = [];

const raw = await readFile(join(root, 'data', 'apps.json'), 'utf8');
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error(`✖ data/apps.json is not valid JSON: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

const { categories, apps } = data;

if (!Array.isArray(categories) || categories.length === 0) {
  errors.push('`categories` must be a non-empty array');
}
if (!Array.isArray(apps)) {
  errors.push('`apps` must be an array');
}

const ALLOWED_KEYS = ['id', 'name', 'url', 'description', 'category', 'iconLetter', 'iconColor', 'tags', 'added', 'submittedBy'];
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @type {Set<string>} */
const seenIds = new Set();

for (const app of apps ?? []) {
  const label = app?.id || app?.name || JSON.stringify(app).slice(0, 40);
  /** @param {string} msg */
  const fail = (msg) => errors.push(`[${label}] ${msg}`);

  for (const key of Object.keys(app)) {
    if (!ALLOWED_KEYS.includes(key)) fail(`unknown field "${key}"`);
  }
  for (const key of ALLOWED_KEYS) {
    if (!(key in app)) fail(`missing required field "${key}"`);
  }

  if (typeof app.id === 'string') {
    if (!ID_RE.test(app.id)) fail('id must be lowercase letters/numbers with hyphens (e.g. "my-app")');
    if (seenIds.has(app.id)) fail('duplicate id — ids must be unique');
    seenIds.add(app.id);
  }

  if (typeof app.name === 'string' && (app.name.length < 1 || app.name.length > 60)) {
    fail('name must be 1–60 characters');
  }

  if (typeof app.url === 'string' && !app.url.startsWith('https://')) {
    fail('url must start with https://');
  }

  if (typeof app.description === 'string' && (app.description.length < 20 || app.description.length > 200)) {
    fail(`description must be 20–200 characters (currently ${app.description.length})`);
  }

  if (typeof app.category === 'string' && Array.isArray(categories) && !categories.includes(app.category)) {
    fail(`category "${app.category}" is not in the categories list`);
  }

  if (typeof app.iconLetter === 'string' && (app.iconLetter.length < 1 || app.iconLetter.length > 2)) {
    fail('iconLetter must be 1–2 characters');
  }

  if (typeof app.iconColor === 'string' && !HEX_RE.test(app.iconColor)) {
    fail('iconColor must be a 6-digit hex color like #5b5bd6');
  }

  if (Array.isArray(app.tags)) {
    if (app.tags.length > 4) fail('at most 4 tags allowed');
    for (const tag of app.tags) {
      if (typeof tag !== 'string' || !ID_RE.test(tag)) fail(`tag "${tag}" must be lowercase-hyphenated`);
    }
  }

  if (typeof app.added === 'string' && !DATE_RE.test(app.added)) {
    fail('added must be a date in YYYY-MM-DD format');
  }

  if (typeof app.submittedBy === 'string' && app.submittedBy.length === 0) {
    fail('submittedBy must not be empty');
  }
}

if (errors.length > 0) {
  console.error(`✖ data/apps.json has ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n`);
  for (const err of errors) console.error(`  • ${err}`);
  console.error('\nSee CONTRIBUTING.md for the field rules.');
  process.exit(1);
}

console.log(`✔ data/apps.json is valid — ${apps.length} apps across ${categories.length} categories.`);
