# Security Policy

PWAverse is a static site with no server, no database, and no user accounts, so its attack surface is small — but we take two things seriously:

1. **Directory integrity** — every listed app must be safe. If an app in the directory turns malicious, deceptive, or starts serving malware, report it immediately.
2. **Site security** — XSS or any way to inject content through `data/apps.json` fields or the service worker.

## Reporting

- **Malicious listed app:** open an issue titled `Remove app: <name>` with what you observed. Maintainers treat these as highest priority.
- **Site vulnerability:** please use [GitHub private vulnerability reporting](https://github.com/Gacaca6/PWAverse/security/advisories/new) rather than a public issue, so a fix can land before details are public.

We aim to acknowledge reports within 72 hours. Thank you for keeping the open web safe. 💜
