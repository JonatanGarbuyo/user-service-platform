import type { ResolvedDeployment } from './targets.js';
import {
  drainSessionFailureTail,
  parseTailLines,
  SESSION_FAILURE_TAIL_DRAIN_MS,
  summarizeSessionFailures,
  type SessionFailureTailHandle,
} from './diagnostic-tail.js';

export type { SessionFailureTailHandle } from './diagnostic-tail.js';

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
  // Optional bounded diagnostic tail for the sandbox smoke window (ticket
  // #96). When present and the environment is sandbox, the deploy boundary
  // starts the tail immediately before `smoke-sandbox` and always terminates
  // it afterward via `stop()`. Production never receives a tail. Absence of
  // the hook (older harnesses, dry runs without tail support) runs the smoke
  // unchanged.
  readonly startSessionFailureTail?: (
    resolved: ResolvedDeployment,
    configPath: string,
  ) => Promise<SessionFailureTailHandle>;
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

async function collectTailLines(
  tail: SessionFailureTailHandle | null,
  io: DeployIo,
): Promise<readonly string[]> {
  if (tail === null) {
    return [];
  }
  try {
    return await tail.stop();
  } catch {
    io.log('sandbox smoke diagnostic: session failure tail stop failed');
    return [];
  }
}

function tailExitedBeforeSmoke(tail: SessionFailureTailHandle): boolean {
  if (tail.exitedBeforeSmoke) {
    return true;
  }
  try {
    return !tail.isLive();
  } catch {
    return false;
  }
}

// Bounded post-failure drain (ticket #102): keeps the live tail open briefly
// after the smoke client already observed the failure so the asynchronous
// Cloudflare invocation envelope can arrive. Ends early on a whitelisted
// event; otherwise expires and reports `phase unavailable` with a liveness
// proof. The drain sleep stays awaited and referenced (ticket #100), raw
// incremental snapshots stay private, and only whitelisted `event`/`phase`/
// optional `requestId`/`environment` may be logged.
async function collectDrainedTailLines(
  tail: SessionFailureTailHandle,
  io: DeployIo,
): Promise<{ readonly lines: readonly string[]; readonly liveThroughDrain: boolean }> {
  try {
    const outcome = await drainSessionFailureTail(tail);
    return { lines: outcome.lines, liveThroughDrain: outcome.liveThroughDrain };
  } catch {
    io.log('sandbox smoke diagnostic: session failure tail stop failed');
    return { lines: [], liveThroughDrain: false };
  }
}

// Sandbox smoke wrapped with the bounded diagnostic tail (tickets #96/#98/#102).
// Starts the tail immediately before the smoke and always terminates it
// afterward. Tail startup waits its bounded readiness grace before the smoke
// runs, so the tail is connected before the fast health then anonymous `GET
// /v1/me` sequence; a slow connect still degrades to the ticket-allowed
// `phase unavailable` rather than unfiltered logs. A child that exits during
// the grace is classified as `exited before smoke` with a fixed safe message
// rather than a misleading live empty tail. A failed smoke keeps the live tail
// open for the bounded drain window before terminating it, preferring early
// exit on a whitelisted event.
async function runSandboxSmokeWithDiagnostics(
  resolved: ResolvedDeployment,
  configPath: string,
  io: DeployIo,
  runner: DeployCommandRunner,
): Promise<void> {
  let tail: SessionFailureTailHandle | null = null;
  if (io.startSessionFailureTail !== undefined) {
    try {
      tail = await io.startSessionFailureTail(resolved, configPath);
    } catch {
      tail = null;
      io.log(
        'sandbox smoke diagnostic: session failure tail unavailable ' +
          '(continuing smoke without diagnostics)',
      );
    }
  }
  try {
    await runStep('smoke-sandbox', 'npm', ['run', 'smoke:sandbox'], runner);
  } catch (smokeError) {
    if (tail !== null && tailExitedBeforeSmoke(tail)) {
      await collectTailLines(tail, io);
      io.log('sandbox smoke diagnostic: session failure tail unavailable (exited before smoke)');
      throw smokeError;
    }
    if (tail !== null) {
      const drained = await collectDrainedTailLines(tail, io);
      const events = parseTailLines(drained.lines);
      if (events.length > 0) {
        io.log(summarizeSessionFailures(events));
      } else if (drained.liveThroughDrain) {
        io.log(
          `${summarizeSessionFailures([])} (tail live through ${String(SESSION_FAILURE_TAIL_DRAIN_MS)}ms drain)`,
        );
      } else {
        io.log(`${summarizeSessionFailures([])} (tail exited during drain)`);
      }
      throw smokeError;
    }
    io.log(summarizeSessionFailures(parseTailLines(await collectTailLines(tail, io))));
    throw smokeError;
  }
  const events = parseTailLines(await collectTailLines(tail, io));
  if (events.length > 0) {
    io.log(summarizeSessionFailures(events));
  } else {
    io.log('sandbox smoke diagnostic: no session.resolve-failed event observed');
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
      await runSandboxSmokeWithDiagnostics(request.resolved, configPath, io, runner);
    }
    io.log(`deployed worker=${request.resolved.workerName}`);
    return { workerName: request.resolved.workerName, steps };
  } finally {
    io.cleanup(configPath);
  }
}
