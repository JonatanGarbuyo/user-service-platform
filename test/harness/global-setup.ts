import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Harness global setup (ticket #124, ADR-0012). The whole-Worker harness boots
// Wrangler with the repository `wrangler.jsonc`, whose Static Assets entry
// points at the built administration SPA (`admin/dist`). Wrangler refuses to
// boot when that directory is missing, so the harness rebuilds it
// deterministically from versioned sources before any test listens. This also
// gates the frontend production build inside the existing Node harness suite
// without touching CI workflow files: a broken admin build fails here with
// the build output attached, before Wrangler ever starts.
export default async function setup(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', 'build:admin'], {
      cwd: repoRoot,
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (stdout.trim().length > 0) {
      console.log(stdout);
    }
    if (stderr.trim().length > 0) {
      console.error(stderr);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Administration SPA build failed before the Worker harness: ${detail}`);
  }
  if (!existsSync(resolve(repoRoot, 'admin', 'dist', 'index.html'))) {
    throw new Error(
      'Administration SPA build produced no admin/dist/index.html; refusing to start the Worker harness.',
    );
  }
}
