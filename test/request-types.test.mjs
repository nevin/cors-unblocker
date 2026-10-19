import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REQUEST_CATEGORIES, categorizeDevtoolsEntry, categorizeWebRequest, isRequestCategory } from '../dist-test/shared/requestTypes.js';

describe('request categories', () => {
  it('lists the DevTools Network filters in order', () => {
    assert.deepEqual(REQUEST_CATEGORIES.map((category) => category.label), ['Fetch/XHR', 'Doc', 'CSS', 'JS', 'Font', 'Img', 'Media', 'Manifest', 'Socket', 'Wasm', 'Other']);
  });

  it('maps webRequest types from Chrome and Firefox', () => {
    const url = 'https://app.dev/x';
    assert.equal(categorizeWebRequest('xmlhttprequest', url), 'fetch');
    assert.equal(categorizeWebRequest('main_frame', url), 'doc');
    assert.equal(categorizeWebRequest('sub_frame', url), 'doc');
    assert.equal(categorizeWebRequest('stylesheet', url), 'css');
    assert.equal(categorizeWebRequest('script', url), 'js');
    assert.equal(categorizeWebRequest('font', url), 'font');
    assert.equal(categorizeWebRequest('image', url), 'img');
    assert.equal(categorizeWebRequest('imageset', url), 'img');
    assert.equal(categorizeWebRequest('media', url), 'media');
    assert.equal(categorizeWebRequest('web_manifest', url), 'manifest');
    assert.equal(categorizeWebRequest('websocket', url), 'socket');
    assert.equal(categorizeWebRequest('ping', url), 'other');
    assert.equal(categorizeWebRequest(undefined, url), 'other');
  });

  it('recognises WebAssembly and web app manifests by URL', () => {
    assert.equal(categorizeWebRequest('xmlhttprequest', 'https://app.dev/app.wasm'), 'wasm');
    assert.equal(categorizeWebRequest('other', 'https://app.dev/site.webmanifest'), 'manifest');
    assert.equal(categorizeWebRequest('other', 'https://app.dev/manifest.json'), 'manifest');
    assert.equal(categorizeWebRequest('xmlhttprequest', 'https://app.dev/api/manifest.json/items'), 'fetch');
  });

  it('maps DevTools entries by resource type, then by MIME type', () => {
    const url = 'https://app.dev/x';
    assert.equal(categorizeDevtoolsEntry('fetch', 'application/json', url), 'fetch');
    assert.equal(categorizeDevtoolsEntry('xhr', undefined, url), 'fetch');
    assert.equal(categorizeDevtoolsEntry('document', undefined, url), 'doc');
    assert.equal(categorizeDevtoolsEntry('websocket', undefined, url), 'socket');
    assert.equal(categorizeDevtoolsEntry('ping', 'text/plain', url), 'other');
    // Firefox entries carry only the MIME type.
    assert.equal(categorizeDevtoolsEntry(undefined, 'text/html; charset=utf-8', url), 'doc');
    assert.equal(categorizeDevtoolsEntry(undefined, 'text/css', url), 'css');
    assert.equal(categorizeDevtoolsEntry(undefined, 'application/javascript', url), 'js');
    assert.equal(categorizeDevtoolsEntry(undefined, 'font/woff2', url), 'font');
    assert.equal(categorizeDevtoolsEntry(undefined, 'image/png', url), 'img');
    assert.equal(categorizeDevtoolsEntry(undefined, 'video/mp4', url), 'media');
    assert.equal(categorizeDevtoolsEntry(undefined, 'application/wasm', url), 'wasm');
    assert.equal(categorizeDevtoolsEntry(undefined, 'application/json', url), 'fetch');
    assert.equal(categorizeDevtoolsEntry(undefined, 'application/octet-stream', url), 'other');
  });

  it('accepts only known categories from stored data', () => {
    assert.equal(isRequestCategory('fetch'), true);
    assert.equal(isRequestCategory('xhr'), false);
    assert.equal(isRequestCategory(undefined), false);
  });
});
