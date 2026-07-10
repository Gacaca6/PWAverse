<!-- Thanks for contributing to PWAverse! 💜 Delete the section that doesn't apply. -->

## Adding an app

**App name:**
**URL:**
**Your relationship to the app:** <!-- e.g. I built it / I'm a fan -->

Checklist:

- [ ] The app has a web app manifest and a service worker (installable, or designed for Add to Home Screen)
- [ ] My entry follows the field rules in [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md) (id format, description ≤ 160 chars, valid category, hex color)
- [ ] `node scripts/validate-apps.mjs` passes locally (CI will also check this)

## Site improvement

**What does this change and why?**

Checklist:

- [ ] No frameworks or build steps introduced (see CONTRIBUTING.md — discuss first if needed)
- [ ] Works in both light and dark themes
- [ ] Tested on a narrow (mobile-width) viewport
- [ ] Offline behavior still works if the service worker or cached assets changed (bump `CACHE_VERSION` in `sw.js` when shell files change)
