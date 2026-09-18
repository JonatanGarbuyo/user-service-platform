import { readFileSync } from 'node:fs';
import { loadTargetsFile, type TargetsFile } from '../../scripts/deploy/targets.js';

// Shared contract-test fixtures for the deployment boundary (ticket #78).
// Both the deploy-targets suite and the sandbox-promotion contract suite
// resolve a provisioned copy of the same versioned file, so naming and
// isolation assertions track `deploy/targets.json` from one place.

// Deterministic non-uniform UUIDs standing in for the out-of-band provisioned
// database ids recorded in `deploy/targets.json` during first-time target
// provisioning (see docs/operations/sandbox-release-runbook.md).
export const CONTRACT_SANDBOX_DATABASE_ID = 'a1b2c3d4-e5f6-4789-a3b5-c6d7e8f90a1b';
export const CONTRACT_PRODUCTION_DATABASE_ID = 'b2c3d4e5-f607-4828-b4c5-d6e7f90a1b2c';

export function loadTargetsFromRepo(): TargetsFile {
  const raw = readFileSync('deploy/targets.json', 'utf8');
  return loadTargetsFile(JSON.parse(raw) as unknown);
}

// Real database ids are provisioned out-of-band and recorded in
// `deploy/targets.json`; contract tests resolve a provisioned copy so naming
// and isolation hold independently of provisioning state.
export function provisionedTargetsForContract(file: TargetsFile): TargetsFile {
  return {
    ...file,
    targets: file.targets.map((entry) => ({
      ...entry,
      environments: {
        sandbox: { ...entry.environments.sandbox, databaseId: CONTRACT_SANDBOX_DATABASE_ID },
        production: {
          ...entry.environments.production,
          databaseId: CONTRACT_PRODUCTION_DATABASE_ID,
        },
      },
    })),
  };
}
