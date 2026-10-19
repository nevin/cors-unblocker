# CORS Unblocker privacy policy

_Effective 19 October 2026. Applies to CORS Unblocker 0.3.1 and later, for Chrome, Edge and Firefox._

**In short:** CORS Unblocker works entirely inside your browser. It does not collect, send, sell or share any data. There are no accounts, analytics, ads, trackers or remote servers.

## What the extension reads, and why

To do its job, the extension sees some details of the network requests web pages make:

| What | Why | Where it is kept | How long |
|---|---|---|---|
| Your rules and settings (trusted pages, skip rules, options) | To apply your rules | Your browser's local extension storage | Until you change or reset them, or remove the extension |
| Cross-origin API calls on a tab that **failed CORS**: the URL without its query string or fragment, the page's origin, the method, the names (not values) of headers the page asked to send, whether the call carried cookies, and why it failed | To show blocked calls and offer a fix (toolbar badge, popup, DevTools panel) | Session storage, in memory for the current browser session | Cleared when the tab navigates or closes, or the browser closes. You can turn this off in Settings under "Blocked-call detection" |
| Recently requested URLs, without query strings or fragments, **only while overrides are on** | To suggest rules in Settings and the DevTools panel | Session storage, in memory for the current browser session | Cleared when the browser closes |
| Request and response headers of cross-origin API calls | To check whether a call would fail CORS, and to add or adjust CORS headers | In memory only, never written to storage | From when the request is sent until its response arrives |

The extension does **not** read page content, form data, passwords or keystrokes. Request headers, which can include cookies or authorization tokens, are held in memory only until the response arrives; of those, the extension keeps only whether a `Cookie` header was present, to tell when a call needs CORS credentials support.

## What the extension sends

Nothing. CORS Unblocker makes no requests to any server and has no server of its own. All of the data above stays on your device and is never transmitted to the developer or anyone else.

## Permissions

- **Access to all websites** (`<all_urls>`), **`webRequest`** and, in Chrome, **`declarativeNetRequest`**: to see which cross-origin calls fail CORS and to change CORS response headers for the pages you trust. You choose which pages are affected; nothing changes until you turn overrides on.
- **`storage`**: to save your rules and settings, and to keep the session-only lists described above.
- **`alarms`**: to switch overrides back on when you use "Pause 1 hour".

## Your choices

- Turn overrides off, or pause them, from the toolbar popup.
- Turn off blocked-call detection in Settings.
- Remove all rules and settings with "Reset all settings" in Settings, or by removing the extension.

## Changes

Changes to this policy will be published in this file in the project repository, with a new effective date.

## Contact

Questions or concerns: open an issue at https://github.com/nevin/cors-unblocker/issues.
