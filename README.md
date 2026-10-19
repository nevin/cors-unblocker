# cors-unblocker

A browser extension for selectively relaxing CORS response headers during local web development, with whitelist and global modes.

## Safety

This is a development tool. Keep it disabled when you are not actively debugging local development requests. Prefer whitelist mode over global mode.

## Finding blocked calls

You don't have to wait for a console error. The extension checks every cross-origin API call (fetch and XHR) the way the browser will, using the server's own response headers, even while overrides are off:

- A red count on the toolbar icon shows how many calls on the current tab are blocked by CORS.
- The popup lists them by API with the reason, for example a missing `Access-Control-Allow-Origin`, a server that allows a different origin, or a preflight that rejects your method or headers.
- **Fix blocked calls** applies exactly the changes needed (turn on overrides, trust the page, allow a method or headers) and tells you what it will change first. Then reload the page to retry.
- Problems no header can fix, such as a preflight answered with 404 or 405, are explained instead of hidden.

Only failing cross-origin calls are kept, without query strings, per tab, for the browser session. They are cleared when the tab navigates or closes, and never leave your browser. Turn detection off in Options under **Blocked-call detection**.

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

## Features

- Master on/off toggle
- Whitelist-only mode
- Global mode for broad local debugging
- One-click allowance for the current tab
- Current-tab coverage status
- Searchable whitelist management
- CORS controls available in the browser Developer Tools panel
- Applies to all matched web request types in Chrome and Firefox
- In whitelist mode, relaxes requests made by trusted pages; a rule's responses are opened to other sites only with a per-rule opt-in
- Allowed methods control the CORS preflight response and do not block network requests.
- Chrome/Edge Manifest V3 build using Declarative Net Request
- Firefox build using response header interception (Firefox 140 or later)
- Request discovery records only while overrides are enabled, drops query strings and fragments, and is kept in session storage, so it is never written to disk and is cleared when the browser closes

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
- `npm run test:e2e` - Load the Chrome build in a real Chromium and run cross-origin requests against a local test server (run `npx playwright install chromium` once first)
- `npm run lint:firefox` - Validate the Firefox build with Mozilla's add-on linter

## License

Copyright (C) 2026 Nevin Paul

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License version 3, as published by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text.
