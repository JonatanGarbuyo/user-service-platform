import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedDeployment } from './targets.js';

// Temporary Wrangler materialization (ticket #78, ADR-0008).
//
// The deployer derives one target-specific Wrangler config from the base
// application config plus the selected deployment target, so Worker name, D1
// binding and non-secret deployment vars are target/environment-specific
// while application code keeps using the stable `DB` binding. The generated
// file is temporary: the orchestrator removes it even when deployment fails,
// and it is never committed.
//
// Base application values below mirror the top-level `wrangler.jsonc`
// (`deploy-materialize.test.ts` fails on drift so the two cannot diverge
// silently). The base file keeps no remote `env` sections: every remote
// deploy goes through this materialization path.
export const BASE_WORKER_MAIN = 'src/index.ts';
export const BASE_COMPATIBILITY_DATE = '2026-08-22';
export const BASE_COMPATIBILITY_FLAGS: readonly string[] = ['nodejs_compat'];
export const BASE_OBSERVABILITY: { readonly enabled: true } = { enabled: true };

export interface TargetD1Binding {
  readonly binding: 'DB';
  readonly database_name: string;
  readonly database_id: string;
  readonly migrations_dir: 'drizzle';
}

export interface TargetWranglerConfig {
  readonly name: string;
  readonly main: typeof BASE_WORKER_MAIN;
  readonly compatibility_date: typeof BASE_COMPATIBILITY_DATE;
  readonly compatibility_flags: readonly string[];
  readonly vars: Record<string, string>;
  readonly observability: { readonly enabled: true };
  readonly d1_databases: readonly [TargetD1Binding];
}

export function buildTargetWranglerConfig(resolved: ResolvedDeployment): TargetWranglerConfig {
  return {
    name: resolved.workerName,
    main: BASE_WORKER_MAIN,
    compatibility_date: BASE_COMPATIBILITY_DATE,
    compatibility_flags: [...BASE_COMPATIBILITY_FLAGS],
    vars: { ENVIRONMENT: resolved.environment, ...resolved.vars },
    observability: { ...BASE_OBSERVABILITY },
    d1_databases: [
      {
        binding: 'DB',
        database_name: resolved.databaseName,
        database_id: resolved.databaseId,
        migrations_dir: 'drizzle',
      },
    ],
  };
}

// Writes the materialized config into an operator-provided directory (the
// orchestrator creates an OS temporary directory) and returns its path.
export function writeTempWranglerConfig(resolved: ResolvedDeployment, directory: string): string {
  const path = join(directory, `wrangler.${resolved.workerName}.json`);
  writeFileSync(path, `${JSON.stringify(buildTargetWranglerConfig(resolved), null, 2)}\n`, 'utf8');
  return path;
}

// Best-effort removal: cleanup runs in `finally` after both success and
// failure, so a missing file (or read-only directory) must never mask the
// deployment outcome.
export function removeTempWranglerConfig(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Intentionally silent: temporary-file hygiene never fails a deployment.
  }
}
