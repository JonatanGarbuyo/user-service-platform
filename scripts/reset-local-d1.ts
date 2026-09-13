import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit clean/reset path for local D1 (ticket #57). Removes Wrangler's
// persisted local D1 state and reapplies the same versioned `./drizzle`
// migrations used by sandbox/production, so the next `wrangler dev` starts
// from an empty database. Only local state under `.wrangler/` is touched:
// this script never takes `--remote` or `--env`, so remote Cloudflare D1
// databases cannot be affected.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localD1State = resolve(root, '.wrangler', 'state', 'v3', 'd1');

await rm(localD1State, { recursive: true, force: true });
console.log(`Removed local D1 state at ${localD1State} (remote databases untouched).`);

const result = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) {
  console.error('Local D1 migration apply failed.');
  process.exit(result.status ?? 1);
}
console.log('Local D1 reset complete: versioned migrations reapplied to empty local state.');
