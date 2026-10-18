# cors-unblocker

A browser extension for selectively relaxing CORS response headers during local web development, with whitelist and global modes.

## Safety

This is a development tool. Keep it disabled when you are not actively debugging local development requests. Prefer whitelist mode over global mode.

## Features

- Master on/off toggle
- Whitelist-only mode
- Global mode for broad local debugging
- One-click allowance for the current tab
- Current-tab coverage status
- Searchable whitelist management
- CORS controls available in the browser Developer Tools panel
- Applies to all matched web request types in Chrome and Firefox
- In whitelist mode, matches both destination URLs and requests initiated by an allowed site
- Allowed methods control the CORS preflight response and do not block network requests.
- Chrome/Edge Manifest V3 build using Declarative Net Request
- Firefox build using response header interception

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

## License

Copyright (C) 2026 Nevin Paul

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License version 3, as published by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text.
