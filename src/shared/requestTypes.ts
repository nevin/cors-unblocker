// Request categories, as the browser's DevTools Network panel groups them.
export type RequestCategory = 'fetch' | 'doc' | 'css' | 'js' | 'font' | 'img' | 'media' | 'manifest' | 'socket' | 'wasm' | 'other';

export const REQUEST_CATEGORIES: ReadonlyArray<{ id: RequestCategory; label: string }> = [
  { id: 'fetch', label: 'Fetch/XHR' },
  { id: 'doc', label: 'Doc' },
  { id: 'css', label: 'CSS' },
  { id: 'js', label: 'JS' },
  { id: 'font', label: 'Font' },
  { id: 'img', label: 'Img' },
  { id: 'media', label: 'Media' },
  { id: 'manifest', label: 'Manifest' },
  { id: 'socket', label: 'Socket' },
  { id: 'wasm', label: 'Wasm' },
  { id: 'other', label: 'Other' }
];

const CATEGORY_IDS = new Set<string>(REQUEST_CATEGORIES.map((category) => category.id));

export function isRequestCategory(value: unknown): value is RequestCategory {
  return typeof value === 'string' && CATEGORY_IDS.has(value);
}

// The browser files WebAssembly and web app manifests under generic types, so recognise them by URL.
function categorizeByUrl(url: string): RequestCategory | null {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (path.endsWith('.wasm')) {
    return 'wasm';
  }
  if (path.endsWith('.webmanifest') || path.endsWith('/manifest.json')) {
    return 'manifest';
  }
  return null;
}

// From a webRequest `type`. Chrome and Firefox share most names; Firefox adds a few of its own.
export function categorizeWebRequest(type: string | undefined, url: string): RequestCategory {
  const byUrl = categorizeByUrl(url);
  if (byUrl) {
    return byUrl;
  }
  switch (type) {
    case 'xmlhttprequest':
      return 'fetch';
    case 'main_frame':
    case 'sub_frame':
      return 'doc';
    case 'stylesheet':
      return 'css';
    case 'script':
      return 'js';
    case 'font':
      return 'font';
    case 'image':
    case 'imageset':
      return 'img';
    case 'media':
      return 'media';
    case 'web_manifest':
      return 'manifest';
    case 'websocket':
    case 'webtransport':
      return 'socket';
    default:
      return 'other';
  }
}

// From a DevTools network (HAR) entry: Chrome's `_resourceType` when present, otherwise the response
// MIME type, which is all Firefox provides.
export function categorizeDevtoolsEntry(resourceType: string | undefined, mimeType: string | undefined, url: string): RequestCategory {
  const byUrl = categorizeByUrl(url);
  if (byUrl) {
    return byUrl;
  }
  switch (resourceType) {
    case 'xhr':
    case 'fetch':
    case 'eventsource':
      return 'fetch';
    case 'document':
      return 'doc';
    case 'stylesheet':
      return 'css';
    case 'script':
      return 'js';
    case 'font':
      return 'font';
    case 'image':
      return 'img';
    case 'media':
      return 'media';
    case 'manifest':
      return 'manifest';
    case 'websocket':
      return 'socket';
    case 'wasm':
      return 'wasm';
    case undefined:
    case '':
      break;
    default:
      return 'other';
  }

  const mime = (mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    return 'doc';
  }
  if (mime === 'text/css') {
    return 'css';
  }
  if (mime.includes('javascript') || mime === 'text/ecmascript') {
    return 'js';
  }
  if (mime.startsWith('font/') || mime.includes('font-')) {
    return 'font';
  }
  if (mime.startsWith('image/')) {
    return 'img';
  }
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    return 'media';
  }
  if (mime === 'application/manifest+json') {
    return 'manifest';
  }
  if (mime === 'application/wasm') {
    return 'wasm';
  }
  if (mime.includes('json') || mime.includes('xml') || mime === 'text/plain') {
    return 'fetch';
  }
  return 'other';
}
