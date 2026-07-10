// @ts-check
/* ---------------------------------------------------------------------------
   PWAverse — app logic
   Plain JavaScript, no dependencies, no build step. Type-checked in-editor
   via `// @ts-check` + JSDoc (TypeScript's checker runs on this file as-is).
   Loads the community app list from data/apps.json and handles search,
   filtering, the detail dialog, and PWA installation.
--------------------------------------------------------------------------- */

/**
 * One entry in data/apps.json — field rules live in data/apps.schema.json.
 * @typedef {Object} App
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} description
 * @property {string} category
 * @property {string} iconLetter
 * @property {string} iconColor
 * @property {string[]} tags
 * @property {string} added
 * @property {string} submittedBy
 */

/**
 * Chrome's install event (not yet in the standard TS DOM lib).
 * @typedef {Event & {
 *   prompt: () => Promise<void>,
 *   userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
 * }} BeforeInstallPromptEvent
 */

const GITHUB_REPO_URL = 'https://github.com/Gacaca6/PWAverse';
const SUBMIT_APP_URL = `${GITHUB_REPO_URL}/issues/new?template=submit-app.yml`;

const state = {
  /** @type {App[]} */
  apps: [],
  /** @type {string[]} */
  categories: [],
  query: '',
  /** @type {string | null} */
  category: null,
};

const els = {
  grid: /** @type {HTMLElement} */ (document.getElementById('app-grid')),
  chips: /** @type {HTMLElement} */ (document.getElementById('category-chips')),
  search: /** @type {HTMLInputElement} */ (document.getElementById('search')),
  count: /** @type {HTMLElement} */ (document.getElementById('results-count')),
  empty: /** @type {HTMLElement} */ (document.getElementById('empty-state')),
  offlineBadge: /** @type {HTMLElement} */ (document.getElementById('offline-badge')),
  installBtn: /** @type {HTMLButtonElement} */ (document.getElementById('install-btn')),
  appDialog: /** @type {HTMLDialogElement} */ (document.getElementById('app-dialog')),
  dialogBody: /** @type {HTMLElement} */ (document.getElementById('dialog-body')),
  iosDialog: /** @type {HTMLDialogElement} */ (document.getElementById('ios-dialog')),
};

/* --- Data loading ---------------------------------------------------- */

async function loadApps() {
  try {
    const res = await fetch('data/apps.json');
    const data = /** @type {{ categories: string[], apps: App[] }} */ (await res.json());
    state.apps = data.apps;
    state.categories = data.categories;
    renderChips();
    render();
  } catch (err) {
    els.grid.innerHTML = '';
    els.empty.hidden = false;
    els.empty.textContent = 'Could not load the app directory. Check your connection and refresh.';
    console.error('Failed to load apps.json', err);
  }
}

/* --- Rendering -------------------------------------------------------- */

/** @returns {App[]} */
function filteredApps() {
  const q = state.query.trim().toLowerCase();
  return state.apps.filter((app) => {
    if (state.category && app.category !== state.category) return false;
    if (!q) return true;
    const haystack = [app.name, app.description, app.category, ...(app.tags || [])]
      .join(' ')
      .toLowerCase();
    return q.split(/\s+/).every((term) => haystack.includes(term));
  });
}

function renderChips() {
  els.chips.innerHTML = '';
  const allChip = makeChip('All', null);
  allChip.setAttribute('aria-pressed', 'true');
  els.chips.appendChild(allChip);
  state.categories.forEach((cat) => els.chips.appendChild(makeChip(cat, cat)));
}

/**
 * @param {string} label
 * @param {string | null} value
 */
function makeChip(label, value) {
  const btn = document.createElement('button');
  btn.className = 'chip';
  btn.type = 'button';
  btn.textContent = label;
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', () => {
    state.category = value;
    els.chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    btn.setAttribute('aria-pressed', 'true');
    render();
  });
  return btn;
}

/**
 * @param {App} app
 * @param {string} [extraClass]
 */
function appIcon(app, extraClass = '') {
  const icon = document.createElement('span');
  icon.className = `app-icon ${extraClass}`.trim();
  icon.style.background = app.iconColor || 'var(--accent)';
  icon.textContent = app.iconLetter || app.name[0];
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function render() {
  const apps = filteredApps();
  els.grid.innerHTML = '';
  els.empty.hidden = apps.length > 0;
  els.count.textContent = `${apps.length} app${apps.length === 1 ? '' : 's'}`;

  apps.forEach((app) => {
    const card = document.createElement('button');
    card.className = 'app-card';
    card.type = 'button';

    const top = document.createElement('div');
    top.className = 'app-card-top';
    top.appendChild(appIcon(app));

    const titleWrap = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = app.name;
    const cat = document.createElement('p');
    cat.className = 'app-category';
    cat.textContent = app.category;
    titleWrap.append(h3, cat);
    top.appendChild(titleWrap);

    const desc = document.createElement('p');
    desc.className = 'app-desc';
    desc.textContent = app.description;

    const tags = document.createElement('div');
    tags.className = 'app-tags';
    (app.tags || []).slice(0, 3).forEach((t) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = t;
      tags.appendChild(tag);
    });

    card.append(top, desc, tags);
    card.addEventListener('click', () => openAppDialog(app));
    els.grid.appendChild(card);
  });
}

/* --- App detail dialog -------------------------------------------------- */

/** @param {App} app */
function openAppDialog(app) {
  els.dialogBody.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'dialog-app-header';
  header.appendChild(appIcon(app));

  const titleWrap = document.createElement('div');
  const h2 = document.createElement('h2');
  h2.id = 'dialog-title';
  h2.textContent = app.name;
  const meta = document.createElement('p');
  meta.textContent = `${app.category} · added ${app.added}`;
  titleWrap.append(h2, meta);
  header.appendChild(titleWrap);

  const desc = document.createElement('p');
  desc.textContent = app.description;

  const tags = document.createElement('div');
  tags.className = 'app-tags';
  (app.tags || []).forEach((t) => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t;
    tags.appendChild(tag);
  });

  const launch = document.createElement('a');
  launch.className = 'btn btn-primary dialog-launch';
  launch.href = app.url;
  launch.target = '_blank';
  launch.rel = 'noopener';
  launch.textContent = `Launch ${app.name} →`;

  els.dialogBody.append(header, desc, tags, launch);
  els.appDialog.showModal();
}

/* --- Search --------------------------------------------------------------- */

els.search.addEventListener('input', () => {
  state.query = els.search.value;
  render();
});

/* --- Install flow (beforeinstallprompt on Android/desktop, manual on iOS) -- */

/** @type {BeforeInstallPromptEvent | null} */
let deferredInstallPrompt = null;

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
  /** @type {{ standalone?: boolean }} */ (window.navigator).standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = /** @type {BeforeInstallPromptEvent} */ (e);
  if (!isStandalone) els.installBtn.hidden = false;
});

if (isIOS && !isStandalone) {
  // iOS never fires beforeinstallprompt — offer manual instructions instead.
  els.installBtn.hidden = false;
}

els.installBtn.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') els.installBtn.hidden = true;
    deferredInstallPrompt = null;
  } else if (isIOS) {
    els.iosDialog.showModal();
  }
});

window.addEventListener('appinstalled', () => {
  els.installBtn.hidden = true;
});

/* --- Online/offline indicator ---------------------------------------------- */

function updateOnlineStatus() {
  els.offlineBadge.hidden = navigator.onLine;
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

/* --- Repo links ------------------------------------------------------------- */

const githubLink = /** @type {HTMLAnchorElement} */ (document.getElementById('github-link'));
const submitLink = /** @type {HTMLAnchorElement} */ (document.getElementById('submit-link'));
githubLink.href = GITHUB_REPO_URL;
submitLink.href = SUBMIT_APP_URL;

/* --- Service worker ----------------------------------------------------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}

loadApps();
