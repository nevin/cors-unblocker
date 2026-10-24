import { createFirefoxHarness } from './firefoxBrowser.mjs';
import { defineAdminPolicyCases } from './policyCases.mjs';

defineAdminPolicyCases({ name: 'Firefox', create: createFirefoxHarness, skip: false });
