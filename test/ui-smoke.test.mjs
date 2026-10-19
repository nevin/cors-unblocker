import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('ui source smoke checks', () => {
  it('devtools panel exposes the primary UI hooks', async () => {
    const html = await source('src/devtools/panel.html');
    const script = await source('src/devtools/panel.ts');

    ['id="devtools-panel"', 'id="control-card"', 'id="panel-header"', 'id="title-group"', 'src="../assets/brand/logo-horizontal-light.svg"', 'src="../assets/brand/logo-horizontal-dark.svg"', 'id="header-controls"', 'id="panel-status"', 'id="power-label"', 'id="open-settings"', 'id="global-warning"', 'id="leave-global"', 'id="configuration-card"', 'id="details-section"', 'id="details-tabs"', 'id="page-url-row"', 'id="coverage"', 'id="effective-rule"', 'id="effective-methods"', 'id="allow-page"', 'Add domain rule', 'id="add-domain-rule"', 'Add active URL', 'Add skip URL', 'id="current-links"', 'id="rules-list"', 'id="current-link-filter-input"', 'id="request-scope-filter"', 'data-request-scope="current"', 'data-request-scope="other"', 'id="rules-filter-input"', 'id="rule-state-filter"', 'id="tab-backup"', 'id="panel-backup"', 'id="backup-actions"', 'id="import-preview"', 'id="import-preview-summary"', 'id="confirm-import-rules"', 'id="cancel-import-rules"', 'id="export-rules"', 'id="import-rules"', 'Requests', 'This page', 'Other tabs', 'Import/Export'].forEach((token) => {
      assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
    assert.match(html, /id="tab-rules"[^>]*class="tab is-active"/);
    assert.match(html, /id="panel-rules"[^>]*class="tab-panel is-visible"/);
    assert.match(script, /request-group-heading/);
    assert.match(script, /createElement\('details'\)/);
    assert.match(script, /groupedRequests\.length/);
    assert.match(script, /collapsedRequestGroups/);
    assert.match(script, /parsedUrl\.hostname/);
    assert.match(script, /Copy URLs for/);
    assert.match(script, /groupedRequests\.map\(\(request\) => request\.url\)\.join\('\\n'\)/);
    assert.doesNotMatch(html, /id="domain-rule-form"|id="domain-pattern"|id="domain-type"|id="domain-rules"/);
    assert.doesNotMatch(html, /id="link-filter-input"/);
    assert.doesNotMatch(html, /id="tab-other"|id="panel-other"|id="panel-domains"/);
  });

  it('DevTools panel leaves global settings to the options page', async () => {
    const html = await source('src/devtools/panel.html');

    assert.match(html, /<h1 id="control-title" class="brand">/);
    assert.doesNotMatch(html, /name="mode"|id="theme"|id="allow-all-headers"|id="allow-credentials"|class="allow-method"/);
    assert.ok(html.indexOf('id="cors-blocked"') < html.indexOf('id="current-panel-title-row"'), 'blocked calls come before the request list');
  });

  it('options page exposes danger zone and managed lists', async () => {
    const html = await source('src/options/index.html');

    ['class="setting-section danger-zone"', 'id="reset"', 'id="list"', 'id="rule-kind"', 'id="discovered-list"', 'id="response-settings"', 'Import/Export rules', 'id="import-preview"', 'id="import-preview-summary"', 'id="confirm-import-rules"', 'id="cancel-import-rules"'].forEach((token) => {
      assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
    assert.equal((html.match(/<h2 id="rules-title">Rules<\/h2>/g) ?? []).length, 1);
  });

  it('popup and DevTools panel expose blocked-call hooks', async () => {
    const popup = await source('src/popup/index.html');
    const panel = await source('src/devtools/panel.html');

    ['id="page-card"', 'id="issue-list"', 'id="fix-details"', 'id="primary-action"', 'id="secondary-action"', 'id="pause"', 'id="open-settings"'].forEach((token) => assert.ok(popup.includes(token), token));
    ['id="cors-blocked"', 'id="cors-blocked-list"', 'id="fix-all-cors"', 'id="reload-inspected"', 'id="blocked-tab-count"'].forEach((token) => assert.ok(panel.includes(token), token));
  });

  it('popup keeps settings out and leads with one product name', async () => {
    const html = await source('src/popup/index.html');

    assert.match(html, /<h1 class="brand">/);
    assert.match(html, /Pause 1 hour/);
    assert.doesNotMatch(html, /name="mode"|id="theme"|CORS Control|Whitelist/);
  });

  it('shared styles define reusable chip and disclosure patterns', async () => {
    const css = await source('src/shared/shared.css');

    ['.methods label:has(.allow-method)', '.method-options label:has(input:checked)', '.advanced-options', '.method-editor[open] summary'].forEach((token) => {
      assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });

  it('every page header shows the logo in a light and a dark variant, named for screen readers', async () => {
    for (const path of ['src/popup/index.html', 'src/devtools/panel.html', 'src/options/index.html']) {
      const html = await source(path);
      assert.match(html, /class="brand-logo brand-logo--light" src="\.\.\/assets\/brand\/logo-horizontal-light\.svg" alt="CORS Unblocker"/, path);
      assert.match(html, /class="brand-logo brand-logo--dark" src="\.\.\/assets\/brand\/logo-horizontal-dark\.svg" alt="CORS Unblocker"/, path);
    }
  });
});

