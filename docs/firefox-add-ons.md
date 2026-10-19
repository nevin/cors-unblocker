# Firefox Add-ons (AMO) submission

Everything addons.mozilla.org asks for, ready to paste. From the matching GitHub release, you need two files:

- `cors-unblocker-firefox-<version>.zip`: the add-on to upload.
- `cors-unblocker-source-<version>.zip`: the source code, which AMO requires because the add-on's files are bundled and minified from TypeScript.

The release's `SHA256SUMS.txt` lists the checksums of both.

## Before you submit (steps only you can do)

1. Create a Firefox account and sign in at https://addons.mozilla.org/developers/. Turn on two-step authentication (AMO requires it to submit) and accept the distribution agreement.
2. **Confirm the add-on ID.** The manifest uses `cors-unblocker@nevin.github.io`. It becomes permanent on the first upload, and every later version must keep it. If you want a different one, change `browser_specific_settings.gecko.id` in `manifest.firefox.json` (and `ADDON_ID` in `e2e/firefox.e2e.mjs`) and release again **before** submitting.
3. Load the zip as a temporary add-on (`about:debugging#/runtime/this-firefox` > Load Temporary Add-on) and click through the popup, the DevTools **CORS** panel and Settings once on a real page.

## Upload

- **How to distribute:** On this site (listed).
- **Platforms:** Firefox only. **Leave Firefox for Android unchecked.** The add-on hasn't been tested on Android, and its DevTools panel doesn't exist there.
- **Upload:** `cors-unblocker-firefox-<version>.zip`. AMO runs the same linter as this project's CI, which reports no errors or warnings.
- **Source code:** "Yes", then upload `cors-unblocker-source-<version>.zip`.

## Notes to reviewer

Paste this into "Notes to Reviewer" on each version:

> **Building from the source archive.** The add-on is written in TypeScript and bundled and minified with esbuild. The build is reproducible: two clean builds produce byte-identical files.
>
> Requirements: Node.js 22 or later with npm (tested on macOS and Ubuntu 24.04). No other tools are needed to build.
>
>     unzip cors-unblocker-source-<version>.zip
>     cd cors-unblocker-source-<version>
>     npm ci
>     npm run build:release
>
> The add-on is then in `release-dist/firefox/`, and matches the files in the uploaded zip. (`npm run package` builds the same output and also zips it; that step needs the `zip` command.)
>
> The source also contains a test-only build (`node scripts/build.mjs firefox --e2e`, output in `dist-e2e/`) with a bridge for automated browser tests. It is never part of a release, and `npm run verify-build` fails if it ever is.
>
> **What it does.** A development tool for CORS errors. It detects cross-origin fetch/XHR calls that fail CORS (from the server's own response headers, in `webRequest.onHeadersReceived`) and, for pages the user chooses to trust, adds or adjusts CORS response headers there. It is off until the user turns it on.
>
> **Permissions.** `<all_urls>`, `webRequest` and `webRequestBlocking`: detect CORS failures and rewrite CORS response headers on whatever development sites the user works on. `storage`: rules, settings, and a session-only list of blocked calls. `alarms`: end the "Pause 1 hour" feature.
>
> **Data.** Nothing is transmitted; `data_collection_permissions` is `none`. Request URLs (without query strings) and CORS-related headers are processed locally, as the privacy policy describes.
>
> **To test:** open any page whose scripts call an API on another origin without CORS headers. The toolbar badge counts blocked calls. In the popup, click "Fix N calls" and then "Reload page", and the calls succeed. DevTools > "CORS" lists the same calls.

## Listing (Describe add-on)

**Name:** CORS Unblocker
**Add-on URL:** `cors-unblocker`

**Summary** (117 of 250 characters):
> Fix CORS errors while you develop: see which calls are blocked, then relax CORS headers only for the pages you trust.

**Description:**

> CORS Unblocker is a development tool for web developers whose app calls APIs on other origins (a local frontend calling a staging API, for example) and runs into CORS errors.
>
> See what's blocked
> • A red number on the toolbar icon counts the calls on the current tab that failed CORS, even while the add-on is switched off.
> • The popup and the DevTools "CORS" panel list each blocked call with the reason: a missing or mismatched Access-Control-Allow-Origin header, a preflight that rejects your method or headers, or a call that sends cookies to a server answering "*".
>
> Fix it in one click
> • "Fix" applies exactly the changes needed, and shows them before you click: turn the add-on on, trust the page, allow a method, headers or credentials.
> • Problems no header can fix, such as a preflight answered with 404, are explained instead of hidden.
>
> Only the pages you trust
> • You trust the page you're developing (localhost:3000, say). Calls that page makes get relaxed CORS headers; every other website keeps normal CORS.
> • Responses that already carry CORS headers are left alone by default, so APIs that handle CORS themselves, including ones that use cookies, keep working.
>
> Safe by default
> • Off until you turn it on. The toolbar icon is greyed out while it's off.
> • "Pause 1 hour" switches overrides off and back on by itself.
> • Nothing leaves your browser: no accounts, analytics or servers.
>
> Open source (GPL-3.0): https://github.com/nevin/cors-unblocker

**Categories:** Web Development
**Tags:** cors, developer tools, api, localhost, debugging

**Support:** website https://github.com/nevin/cors-unblocker/issues. Add a support email if you want one.
**Homepage:** https://github.com/nevin/cors-unblocker
**License:** GNU General Public License v3.0 only
**Requires payment or non-free services:** No

**Privacy policy:** AMO asks for the text itself; paste the contents of [PRIVACY.md](../PRIVACY.md).

## Images

- **Icon:** taken from the add-on (`assets/icon-64.png` and `icon-128.png`). Nothing to upload.
- **Screenshots:** `assets/store/screenshot-1-popup-blocked.png` through `screenshot-4-popup-trusted.png` (1280×800). Suggested captions:
  1. See which calls CORS blocks, and fix them in one click.
  2. Every blocked call, with the reason, in the DevTools CORS panel.
  3. Trust the pages you build; every other site keeps normal CORS.
  4. Know it's on at a glance, and pause it for an hour when you're done.

## Version notes

For "Release notes" on each version, paste that version's `docs/releases/v<version>.md` text, without the Downloads table.

## Data collection

The manifest declares `data_collection_permissions: { required: ["none"] }`. If AMO asks about data collection or transmission, the answer is that the add-on collects and transmits nothing.

## After submission

Listed add-ons are reviewed by Mozilla; source-code submissions can take longer, because a reviewer rebuilds the add-on. Each later version needs the same ID, a higher version number, and its own source archive from that release.
