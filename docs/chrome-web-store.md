# Chrome Web Store submission

Everything the Chrome Web Store developer dashboard asks for, ready to paste. Upload the Chrome zip from the matching GitHub release (`cors-unblocker-chrome-<version>.zip`); its SHA-256 is in that release's `SHA256SUMS.txt`.

## Before you submit (dashboard steps only you can do)

1. Register a developer account at https://chrome.google.com/webstore/devconsole and pay the one-time registration fee.
2. Verify the contact email, and complete the trader / non-trader declaration under **Account**.
3. Install the release zip unpacked (`chrome://extensions` > Developer mode > Load unpacked) and click through the popup, the DevTools **CORS** panel and Settings once on a real page. The automated suite covers behaviour, but the pages themselves have only been checked with simulated data.
4. Create a new item, upload the zip, and fill in the tabs below.

## Store listing tab

**Name** (from the manifest): CORS Unblocker

**Summary** (from the manifest, 117 of 132 characters):
> Fix CORS errors while you develop: see which calls are blocked, then relax CORS headers only for the pages you trust.

**Category:** Developer Tools
**Language:** English

**Detailed description:**

> CORS Unblocker is a development tool for web developers whose app calls APIs on other origins (a local frontend calling a staging API, for example) and runs into CORS errors.
>
> SEE WHAT'S BLOCKED
> • A red number on the toolbar icon counts the calls on the current tab that failed CORS, even while the extension is switched off.
> • The popup and the DevTools "CORS" panel list each blocked call with the reason: a missing or mismatched Access-Control-Allow-Origin header, a preflight that rejects your method or headers, or a call that sends cookies to a server answering "*".
>
> FIX IT IN ONE CLICK
> • "Fix" applies exactly the changes needed, and shows them before you click: turn the extension on, trust the page, allow a method, headers or credentials.
> • Problems no header can fix, such as a preflight answered with 404, are explained instead of hidden.
>
> ONLY THE PAGES YOU TRUST
> • You trust the page you're developing (localhost:3000, say). Calls that page makes get relaxed CORS headers; every other website keeps normal CORS.
> • Responses that already carry CORS headers are left alone by default, so APIs that handle CORS themselves, including ones that use cookies, keep working.
> • Skip rules, per-rule methods, exposed response headers and credentials support are available in Settings.
>
> SAFE BY DEFAULT
> • Off until you turn it on. The toolbar icon is greyed out while it's off.
> • "Pause 1 hour" switches overrides off and back on by itself.
> • Nothing leaves your browser: no accounts, analytics or servers. Privacy policy: https://github.com/nevin/cors-unblocker/blob/main/PRIVACY.md
>
> Open source (GPL-3.0): https://github.com/nevin/cors-unblocker

**Graphic assets** (all in `assets/store/`):

| Field | File |
|---|---|
| Store icon (128×128) | `store-icon-128.png` |
| Screenshots (1280×800, up to 5) | `screenshot-1-popup-blocked.png`, `screenshot-2-devtools.png`, `screenshot-3-settings.png`, `screenshot-4-popup-trusted.png` |
| Small promo tile (440×280) | `promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `promo-marquee-1400x560.png` |

**Additional fields:** Homepage URL: https://github.com/nevin/cors-unblocker. Support URL: https://github.com/nevin/cors-unblocker/issues.

## Privacy practices tab

**Single purpose:**
> Help web developers find and fix CORS errors during development, by showing which cross-origin calls are blocked and relaxing CORS response headers for pages the developer chooses to trust.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `declarativeNetRequest` | Adds or adjusts CORS response headers (Access-Control-Allow-Origin, -Methods, -Headers, -Credentials, -Expose-Headers, Vary) on responses to requests made by pages the user has chosen to trust, and leaves requests the user skips untouched. This is the extension's core function. |
| `webRequest` | Observes cross-origin API requests and their response headers, without blocking or changing them, to detect which calls the browser will block for CORS and why. That powers the toolbar count, the popup and the DevTools panel. Also notes request URLs, without query strings, while overrides are on, to suggest rules. |
| `storage` | Saves the user's rules and settings locally, and keeps the per-tab list of blocked calls in session storage, which is cleared when the tab navigates or closes. |
| `alarms` | Switches overrides back on when the user's "Pause 1 hour" ends, even if the service worker was asleep. |
| Host permission `<all_urls>` | The extension is used on whatever local, staging or production sites a developer is working on, which cannot be known in advance; its rules and detection must be able to apply to any origin. Nothing changes on a site unless the user turns overrides on and trusts a page (or chooses global mode, which shows a warning). |

**Remote code:** No, I am not using remote code. All code is in the package; there is no `eval`. The DevTools panel calls `chrome.devtools.inspectedWindow.eval('window.location.href')` only to read the inspected page's address.

**Data usage.** The extension makes no requests to any server and transmits nothing off the device. What it reads locally (see PRIVACY.md) is the URLs of cross-origin requests (without query strings) and their CORS-related headers, to diagnose CORS failures.

- If the form asks only about data you **collect or transmit**: select none.
- If you choose to disclose locally handled data as well: select **Web history**, and note that it is processed only on the device and never transmitted.
- Certify all three statements: the data is not sold to third parties; it is not used or transferred for purposes unrelated to the single purpose; it is not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/nevin/cors-unblocker/blob/main/PRIVACY.md

## Distribution tab

Public, all regions, free. No in-app purchases.

## Notes for the reviewer (Test instructions)

> No account or setup is needed. To see the extension work:
> 1. Open any page whose scripts call an API on another origin that doesn't send CORS headers. The red number on the toolbar icon counts the blocked calls.
> 2. Click the toolbar icon: the popup lists the blocked calls with reasons. Click "Fix N calls", then "Reload page"; the calls now succeed.
> 3. Open DevTools > "CORS" to see the same calls with per-call fixes.
> 4. Settings (from the popup) lists the trusted page that was added. Other websites are unaffected.
>
> The extension starts switched off and never sends data anywhere.

## Expect an in-depth review

Broad host access (`<all_urls>`) together with `webRequest` puts the item into Chrome's in-depth review, which can take longer than usual. The justifications above explain why both are needed.
