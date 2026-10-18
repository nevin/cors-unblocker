import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

function collectAttributes(html, attribute) {
  return [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((match) => match[1]);
}

function collectIds(html) {
  return collectAttributes(html, 'id');
}

function assertUniqueIds(path, html) {
  const ids = collectIds(html);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], [], `${path} should not contain duplicate ids`);
}

function assertReferencesExistingIds(path, html, attribute) {
  const ids = new Set(collectIds(html));
  const references = collectAttributes(html, attribute)
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean);
  const missing = references.filter((reference) => !ids.has(reference));
  assert.deepEqual(missing, [], `${path} ${attribute} references should point to existing ids`);
}

function assertLabelsTargetExistingControls(path, html) {
  assertReferencesExistingIds(path, html, 'for');
}

describe('ui integrity checks', () => {
  for (const path of ['src/devtools/panel.html', 'src/options/index.html', 'src/popup/index.html']) {
    it(`${path} has valid ids and control references`, async () => {
      const html = await source(path);

      assertUniqueIds(path, html);
      assertLabelsTargetExistingControls(path, html);
      assertReferencesExistingIds(path, html, 'aria-controls');
      assertReferencesExistingIds(path, html, 'aria-labelledby');
    });
  }
});
