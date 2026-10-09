import { it } from 'vitest';
import { runAdminBrowserTest } from '../../scripts/admin-browser-test.js';

// Existing Node harness CI gate runs the real browser against private local D1.
it('supports real administrator sign-in/reload/logout and regular User denial', async () => {
  await runAdminBrowserTest();
}, 240_000);
