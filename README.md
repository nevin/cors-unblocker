<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-horizontal-dark.svg" />
    <img alt="CORS Unblocker" src="assets/brand/logo-horizontal-light.svg" width="360" />
  </picture>
</p>

# CORS Unblocker

Fix CORS errors while you develop: see which calls are blocked, then relax CORS headers only for the pages you trust. For Chrome, Edge and Firefox.

## Safety

This is a development tool. Keep it disabled when you are not actively debugging local development requests. Prefer whitelist mode over global mode.

## Finding blocked calls

You don't have to wait for a console error. The extension checks every cross-origin API call (fetch and XHR) the way the browser will, using the server's own response headers, even while overrides are off:

- A red count on the toolbar icon shows how many calls on the current tab are blocked by CORS.
- The popup and the DevTools **CORS** panel list them with the reason, for example a missing `Access-Control-Allow-Origin`, a server that allows a different origin, a preflight that rejects your method or headers, or a call that sends cookies to a server answering `Access-Control-Allow-Origin: *`.
- **Fix blocked calls** applies exactly the changes needed (turn on overrides, trust the page, allow a method, headers or credentials) and tells you what it will change first. Then reload the page to retry.
- Problems no header can fix, such as a preflight answered with 404 or 405, are explained instead of hidden.

Only failing cross-origin calls are kept, without query strings, per tab, for the browser session. They are cleared when the tab navigates or closes, and never leave your browser. Turn detection off in Options under **Blocked-call detection**.

## Cookies, response headers and caching

- **Credentials:** a call that sends cookies needs the page's exact origin and `Access-Control-Allow-Credentials: true` instead of `*`. The extension spots these calls by their `Cookie` header and suggests **Allow credentials**. That works in whitelist mode, for pages trusted by their exact origin (such as `http://localhost:3000`). Credentialed calls that carry no cookies can't be detected.
- **Exposed headers:** pages can only read a few response headers (such as `Content-Type`) unless the response exposes the rest. **Expose all response headers** (on by default) makes custom headers like `X-Total-Count` readable.
- **Caching:** whenever the extension sends a specific origin rather than `*`, it adds `Vary: Origin` so caches don't serve one page's response to another.

## Respecting server CORS headers

Some calls on a page need help and some already work, for example an API that handles CORS itself and uses cookies. By default the extension leaves any response that already has `Access-Control-Allow-Origin` untouched, so trusting a page never breaks the calls that were working. If a server sends the wrong origin, the popup offers to override server headers; that setting applies to every trusted page.

## How rules work

A rule trusts the pages it matches. Requests made **by** a trusted page get relaxed CORS headers, whatever API they call:

```text
Rule: http://localhost:3000
  localhost:3000 -> api.staging.dev   relaxed
  evil.com       -> api.staging.dev   untouched
```

So add the page you are developing, not the API it calls. A rule's own responses are opened to every website only when you turn on **Any site may read** for that rule. Global mode relaxes every request from every site.

Skip rules win over everything else. Allowed methods come from the most specific rule that relaxed the request, and a method override on a specific URL (for example one with a query string) refines it.

### Chrome limitations

Chrome rules are generated from the same pattern matcher Firefox uses, and a parity test checks them against it. A few things Chrome's rule engine cannot express:

- A trusted page is matched by domain only, so `http://localhost:3000` also trusts other ports, paths and subdomains of `localhost`. Firefox matches the full pattern.
- A trusted page with a wildcard in the middle of the host, such as `https://www.*.example.com`, cannot be matched as a page, so its requests are not relaxed.
- A skip pattern with a path skips matching request URLs, but not requests made by pages under that path.
- With **Allow credentials** on, Chrome cannot echo the requesting origin, so "Any site may read" has no effect. Requests made by trusted pages still work.
- On calls that send cookies, browsers read `*` literally in `Access-Control-Expose-Headers` and `Access-Control-Allow-Headers`. Chrome rules are static, so exposed headers don't apply to those calls, and only commonly used request headers (`Authorization`, `Content-Type`, `X-Requested-With`, CSRF tokens, `X-Api-Key` and a few more) are allowed by name. Firefox lists the actual response header names.

## Features

- **A popup that answers "what's wrong with this page?"** It shows one card for the current tab with a single next step: fix the blocked calls, reload to retry, trust this page, or resume after a pause.
- **Blocked-call detection** with a red count on the toolbar icon, even while overrides are off.
- **Trusted pages:** requests made by a page you trust get relaxed CORS headers; a rule's own responses are opened to other sites only with a per-rule opt-in.
- **Pause 1 hour** turns overrides off and back on by itself.
- **Respects server CORS headers** by default, so calls that already work keep working.
- Global mode for broad debugging (in Settings, with a warning in the popup while it's on).
- A DevTools **CORS** panel with every blocked call, its reason and a fix, plus the full rule editor.
- Allowed methods shape the preflight response and never block requests.
- Chrome/Edge Manifest V3 build using Declarative Net Request; Firefox build using response header interception (Firefox 140 or later).
- The request log is recorded only while overrides are on, without query strings or fragments, in session storage. It is never written to disk and is cleared when the browser closes.

## Setup

```sh
npm install
npm run build
```

## Load in Chrome or Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose **Load unpacked**.
4. Select `dist/chrome`.

## Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `dist/firefox/manifest.json`.

## Use in Developer Tools

Open Developer Tools for a page and select the **CORS** panel. It shows the inspected page, whether CORS overrides are active, and provides quick enable/disable and whitelist controls.

## Whitelist Examples

```text
https://api.local.test
http://localhost:3000
*.example.dev
*://*.internal.test/*
```

## Scripts

- `npm run check` - TypeScript validation
- `npm run build` - Build Chrome and Firefox extension folders
- `npm test` - Run unit tests for shared logic
- `npm run verify-build` - Build and verify generated extension artifacts
- `npm run test:e2e` - Load the extension into real browsers and make cross-origin calls against a local test server: Chromium through Playwright (run `npx playwright install chromium` once first) and Firefox through Selenium (needs Firefox 140 or later installed). `test:e2e:chrome` and `test:e2e:firefox` run one browser.

  Firefox's WebDriver cannot script extension pages, so the Firefox tests use a test-only build (`dist-e2e/firefox`, from `node scripts/build.mjs firefox --e2e`) that adds a small bridge on `*.test` pages. `verify-build` checks the bridge never reaches a normal or release build.
- `npm run lint:firefox` - Validate the Firefox build with Mozilla's add-on linter

## Privacy

CORS Unblocker never sends data anywhere. See [PRIVACY.md](PRIVACY.md).

## Publishing to the stores

- Chrome Web Store: [docs/chrome-web-store.md](docs/chrome-web-store.md)
- Firefox Add-ons: [docs/firefox-add-ons.md](docs/firefox-add-ons.md)

Each GitHub release has the Chrome zip, the Firefox zip, and the source archive Firefox Add-ons reviewers need.

## Releasing

1. Set the version in `package.json` (`npm version 0.3.0 --no-git-tag-version`) and in both `manifest.*.json` files.
2. Write the notes in `docs/releases/v0.3.0.md`.
3. Commit, push, and wait for CI to pass.
4. Tag and push: `git tag -a v0.3.0 -m "CORS Unblocker 0.3.0" && git push origin v0.3.0`.

The **Release** workflow then re-runs every check on the tagged commit, builds both zips from it, and publishes the GitHub release with the zips and their SHA-256 checksums. To try it without publishing, run **Actions > Release > Run workflow**: you get the zips as workflow artifacts.

## License

Copyright (C) 2026 Nevin Paul

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License version 3, as published by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text.
