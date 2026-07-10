<div align="center">

# ◍ PWAverse

**The community home of Progressive Web Apps.**

[![Validate directory data](https://github.com/Gacaca6/PWAverse/actions/workflows/validate.yml/badge.svg)](https://github.com/Gacaca6/PWAverse/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-5b5bd6.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![No dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#tech-decisions-and-why)

An open-source, community-curated directory where anyone can discover, launch, and install
the best apps of the open web — no app store, no gatekeepers, no downloads.

[**Submit your app**](https://github.com/Gacaca6/PWAverse/issues/new?template=submit-app.yml) ·
[Report a bug](https://github.com/Gacaca6/PWAverse/issues/new?template=bug_report.yml) ·
[Suggest a feature](https://github.com/Gacaca6/PWAverse/issues/new?template=feature_request.yml)

</div>

---

> 🌱 **The dream:** an ecosystem where PWAs are a first-class form of application — instant, installable, offline-capable, and working beautifully on *any* phone, from the newest flagship to a budget device on a 2G connection.

## Why this exists

The web can do almost everything native apps can — offline support, push notifications, home-screen installation, hardware access — but great PWAs are nearly impossible to *find*. There is no living, community-owned place to discover them. PWAverse is that place.

And in the spirit of the mission: **PWAverse is itself a PWA.** Install it, go offline, and it keeps working.

## Features

- 📚 **Curated directory** — every app lives in a simple JSON file the community owns
- 🔍 **Instant search & category filters** — no page loads, no lag
- 📴 **Fully offline-capable** — the directory is cached by a service worker
- 📲 **Installable everywhere** — native install prompt on Android/desktop, guided instructions on iOS
- 🌗 **Dark & light themes** — follows your system preference
- ✅ **CI-validated data** — every submission is automatically checked against the [directory schema](data/apps.schema.json)
- 🧪 **Live PWA checks** — CI visits every submitted app and verifies it's reachable, has a valid manifest, and registers a service worker; the whole directory is re-swept weekly for link rot
- 🎓 **PWA report cards** — every app gets an automated grade (A/B/C) for installability, offline readiness, and iOS friendliness, refreshed weekly and shown right in the directory — no other PWA directory has this
- 🚫 **No tracking, no ads, no build step** — plain HTML, CSS, and JavaScript

## Add your app to the directory

That's the whole point! Two ways, pick whichever you like:

| | How | Time |
|---|---|---|
| **Easiest** | [Fill in the app submission form](https://github.com/Gacaca6/PWAverse/issues/new?template=submit-app.yml) — a maintainer does the rest | ~2 min |
| **Direct** | Add one entry to [`data/apps.json`](data/apps.json) and open a PR — see [CONTRIBUTING.md](CONTRIBUTING.md) | ~5 min |

Every submission is reviewed by a human and validated by CI. Indie apps are especially welcome — discovery is what this project exists for.

## Run it locally

No build tools needed. Clone and serve:

```bash
git clone https://github.com/Gacaca6/PWAverse.git
cd PWAverse

# with Python
python -m http.server 8080

# or with Node
npx serve .
```

Then open `http://localhost:8080`. To run the same checks CI runs before opening a PR:

```bash
node scripts/validate-apps.mjs   # directory data rules
node scripts/check-pwas.mjs      # visit every listed app and verify it's a real PWA
node scripts/score-pwas.mjs      # regenerate the PWA report cards (data/scores.json)
```

## Roadmap

- [x] **v0.1** — Directory: browse, search, filter, launch, install
- [x] **v0.2** — App submission via GitHub issue form + CI validation of directory data
- [x] **v0.3** — Automated PWA checks: CI verifies each submitted app's manifest & service worker, plus a weekly link-rot sweep
- [x] **v0.4** — PWA report cards: per-app grades for installability, offline support, and iOS friendliness, auto-refreshed weekly and displayed in the directory
- [ ] **v0.5** — Screenshots and richer app pages
- [ ] **v1.0** — Community moderation, ratings, and multi-language support

Ideas welcome — [open an issue](https://github.com/Gacaca6/PWAverse/issues/new?template=feature_request.yml) and let's talk.

## Tech decisions (and why)

- **No framework, no build step.** Anyone who knows basic HTML/CSS/JS can contribute, and the site can be hosted anywhere for free (GitHub Pages, Cloudflare Pages, Netlify).
- **Typed without compiling.** The JavaScript uses `// @ts-check` + JSDoc, so editors run TypeScript's checker on the plain `.js` files that ship to the browser — type safety with zero toolchain.
- **Data lives in the repo.** The app list is a JSON file under version control — the community literally owns the data, and every addition is reviewed in the open.
- **Static-first.** No servers, no databases, no costs that could kill the project later.

## Community

- [Code of Conduct](CODE_OF_CONDUCT.md) — be kind; first-time contributors are the point, not a problem
- [Contributing guide](CONTRIBUTING.md) — field rules, review process, local testing
- [Security policy](SECURITY.md) — how to report a malicious listing or a site vulnerability

## License

[MIT](LICENSE) — use it, fork it, build on it.
