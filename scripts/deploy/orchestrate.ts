import type { ResolvedDeployment } from './targets.js';

// Deployment orchestration (ticket #78, ADR-0008).
//
// Reuses the existing migration, deploy, deployment-record and smoke
// semantics rather than creating a parallel release model: versioned D1
// migrations are validated locally, applied remotely, then the Worker is
// deployed from a temporary target-specific Wrangler config. Sandbox releases
// record the deployment and run the existing smoke test; production releases
// record the deployment without smoke and require an explicit confirmation.
//
// Production safety: a production deployment proceeds only when `confirm`
// exactly equals the materialized Worker name. The check runs before
// preflight and any remote mutation, and no push/merge path can supply it
// implicitly. A dry run executes the read-only preflight and then returns
// without running any mutating deployment command. The
// temporary config is removed in `finally`, even when deployment fails.
//
// Secret boundary: the orchestrator passes Cloudflare credentials through by
// inheritance (child processes keep their own environment) and never reads,
// logs, or forwards secret values. Logs carry only non-secret deployment
// metadata: target key, environment, Worker/D1 names and step outcomes.

export type DeploymentStep =
  | 'preflight'
  | 'validate-migrations-local'
  | 'migrate-remote'
  | 'deploy-worker'
  | 'record-deployment'
  | 'smoke-sandbox';

export interface DeployRequest {
  readonly resolved: ResolvedDeployment;
  readonly confirm?: string;
  readonly dryRun?: boolean;
}

export interface DeployCommandResult {
  readonly exitCode: number;
}

export type DeployCommandRunner = (command: string, args: string[]) => Promise<DeployCommandResult>;

export interface DeployIo {
  readonly materialize: (resolved: ResolvedDeployment) => string;
  readonly cleanup: (path: string) => void;
  readonly preflight: (resolved: ResolvedDeployment) => Promise<void>;
  readonly log: (message: string) => void;
}

// The only accepted production confirmation is the target Worker name
// itself: the operator must name the exact production Worker being mutated.
export function productionConfirmFor(resolved: ResolvedDeployment): string {
  return resolved.workerName;
}

export function planDeploymentSteps(request: DeployRequest): DeploymentStep[] {
  const steps: DeploymentStep[] = [
    'preflight',
    'validate-migrations-local',
    'migrate-remote',
    'deploy-worker',
    'record-deployment',
  ];
  if (request.resolved.environment === 'sandbox') {
    steps.push('smoke-sandbox');
  }
  return steps;
}

function assertProductionConfirmed(request: DeployRequest): void {
  if (request.resolved.environment !== 'production') {
    return;
  }
  const expected = productionConfirmFor(request.resolved);
  if (request.confirm !== expected) {
    throw new Error(
      `Refusing production deployment without explicit confirmation: confirm must exactly equal the target Worker name ("${expected}"). Production is never an automatic side effect of sandbox or main.`,
    );
  }
}

async function runStep(
  step: DeploymentStep,
  command: string,
  args: string[],
  runner: DeployCommandRunner,
): Promise<void> {
  const result = await runner(command, args);
  if (result.exitCode !== 0) {
    throw new Error(`${step} failed (exit ${String(result.exitCode)}).`);
  }
}

export interface DeploymentOutcome {
  readonly workerName: string;
  readonly steps: DeploymentStep[];
}

export async function runDeployment(
  request: DeployRequest,
  io: DeployIo,
  runner: DeployCommandRunner,
): Promise<DeploymentOutcome> {
  const configPath = io.materialize(request.resolved);
  try {
    assertProductionConfirmed(request);
    await io.preflight(request.resolved);
    const steps = planDeploymentSteps(request);
    if (request.dryRun === true) {
      io.log(
        `dry-run target=${request.resolved.targetKey} environment=${request.resolved.environment} worker=${request.resolved.workerName} database=${request.resolved.databaseName} steps=${steps.join(',')}`,
      );
      return { workerName: request.resolved.workerName, steps };
    }
    io.log(
      `deploy target=${request.resolved.targetKey} environment=${request.resolved.environment} worker=${request.resolved.workerName}`,
    );
    // Local migration validation uses the base config (no --config): it
    // proves the versioned migrations apply before any remote mutation.
    await runStep(
      'validate-migrations-local',
      'npx',
      ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'],
      runner,
    );
    await runStep(
      'migrate-remote',
      'npx',
      ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath],
      runner,
    );
    await runStep('deploy-worker', 'npx', ['wrangler', 'deploy', '--config', configPath], runner);
    await runStep(
      'record-deployment',
      'npx',
      ['wrangler', 'deployments', 'list', '--config', configPath],
      runner,
    );
    if (request.resolved.environment === 'sandbox') {
      await runStep('smoke-sandbox', 'npm', ['run', 'smoke:sandbox'], runner);
    }
    io.log(`deployed worker=${request.resolved.workerName}`);
    return { workerName: request.resolved.workerName, steps };
  } finally {
    io.cleanup(configPath);
  }
}
