import { canSetChromePolicy, CHROME_POLICY_DIRECTORY, createChromeHarness } from './chromeBrowser.mjs';
import { defineAdminPolicyCases } from './policyCases.mjs';

// Chrome reads policy from a system folder. CI makes it writable; elsewhere these cases are skipped,
// but on CI a missing folder fails them rather than skipping silently.
const writable = await canSetChromePolicy();
defineAdminPolicyCases({
  name: 'Chrome',
  create: createChromeHarness,
  skip: writable || process.env.CI ? false : `needs a writable ${CHROME_POLICY_DIRECTORY}, which CI sets up`
});
