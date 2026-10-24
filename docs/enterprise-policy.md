# Managing CORS Unblocker in an organization

IT administrators can enforce three settings through the browser's own policy system. Users see what's managed in the popup, the DevTools panel and Settings, and can't change it.

| Key | Type | Effect |
|---|---|---|
| `disableOverrides` | boolean | `true` keeps CORS overrides off: the extension never changes a response, and users can't switch it on. Blocked calls are still detected and explained, so developers know to fix the server. |
| `trustedPages` | array of strings | Pages trusted for every user, written as in Settings (`localhost:3000`, `https://app.dev.example.com`, `*.dev.example.com`). Users can add their own pages but can't edit or remove these. A page without a port matches every port. |
| `blockEveryWebsiteMode` | boolean | `true` removes "Every website" mode: only trusted pages and individually unblocked calls get relaxed CORS. |

Leave a key out to leave that choice to users. Policy is never stored with the user's own settings, so removing it puts each user back to their own choices.

## Chrome and Edge

The policy goes under the extension's ID, which is the last part of its Chrome Web Store address (for example `https://chromewebstore.google.com/detail/cors-unblocker/<extension-id>`). The keys are declared in [`policy-schema.json`](../policy-schema.json), which Chrome uses to validate them. Check what Chrome loaded at `chrome://policy` (tick "Show policies with no value set").

**Windows (registry or Group Policy):**

```
HKEY_LOCAL_MACHINE\Software\Policies\Google\Chrome\3rdparty\extensions\<extension-id>\policy
  disableOverrides        REG_DWORD  1
  blockEveryWebsiteMode   REG_DWORD  1
HKEY_LOCAL_MACHINE\Software\Policies\Google\Chrome\3rdparty\extensions\<extension-id>\policy\trustedPages
  1                       REG_SZ     localhost:3000
  2                       REG_SZ     https://app.dev.example.com
```

For Microsoft Edge, use `Software\Policies\Microsoft\Edge\3rdparty\extensions\<edge-extension-id>\policy`.

**macOS (configuration profile):** in a profile for the `com.google.Chrome.extensions.<extension-id>` domain:

```xml
<key>disableOverrides</key>
<false/>
<key>blockEveryWebsiteMode</key>
<true/>
<key>trustedPages</key>
<array>
  <string>localhost:3000</string>
  <string>https://app.dev.example.com</string>
</array>
```

**Linux:** a JSON file in `/etc/opt/chrome/policies/managed/` (Chromium: `/etc/chromium/policies/managed/`):

```json
{
  "3rdparty": {
    "extensions": {
      "<extension-id>": {
        "blockEveryWebsiteMode": true,
        "trustedPages": ["localhost:3000", "https://app.dev.example.com"]
      }
    }
  }
}
```

**Google Admin console:** Devices › Chrome › Apps & extensions › Users & browsers, select CORS Unblocker and paste the same keys as JSON under "Policy for extensions":

```json
{
  "blockEveryWebsiteMode": { "Value": true },
  "trustedPages": { "Value": ["localhost:3000", "https://app.dev.example.com"] }
}
```

## Firefox

Add the keys under `3rdparty.Extensions` and the add-on's ID, `cors-unblocker@nevin.github.io`, in `policies.json` (in the `distribution` folder next to the Firefox program, or `/etc/firefox/policies/` on Linux):

```json
{
  "policies": {
    "3rdparty": {
      "Extensions": {
        "cors-unblocker@nevin.github.io": {
          "blockEveryWebsiteMode": true,
          "trustedPages": ["localhost:3000", "https://app.dev.example.com"]
        }
      }
    }
  }
}
```

On Windows, the same keys can be set through Firefox's Group Policy templates, under `Software\Policies\Mozilla\Firefox\3rdparty\Extensions\cors-unblocker@nevin.github.io`. Check what Firefox loaded at `about:policies`. Firefox reads policy when it starts, so restart it after a change.

To install the extension for everyone as well, use the browser's own extension policies (`ExtensionInstallForcelist` in Chrome, `ExtensionSettings` in Firefox).

## How it's tested

The end-to-end tests set these policies through each browser's real policy engine (Firefox's `policies.json` and Chrome's Linux policy folder), then check in a real browser that:

- trusted pages work with no rules of the user's own;
- "Every website" is ignored;
- with overrides off, no headers change while blocked calls are still counted.
