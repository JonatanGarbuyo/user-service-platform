import { runCommand, type CommandExecutor } from './runner.js';
import { isWorkerTimeout } from './worker-timeout.js';

export interface GateResult {
  name: string;
  ok: boolean;
  output: string;
}

// Repository quality gates mirror CI (`/.github/workflows/ci.yml`): lint with
// zero warnings, formatting, typecheck, OpenAPI drift, Workers runtime tests,
// and Node harness tests. They run sequentially and stop at the first failure
// so the terminal report names the failing gate.
export const QUALITY_GATES: readonly { name: string; args: readonly string[] }[] = [
  { name: 'lint', args: ['run', 'lint'] },
  { name: 'format:check', args: ['run', 'format:check'] },
  { name: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'openapi:check', args: ['run', 'openapi:check'] },
  { name: 'workers tests', args: ['run', 'test'] },
  { name: 'node/harness tests', args: ['run', 'test:harness'] },
];

export async function runQualityGates(
  execute: CommandExecutor = runCommand,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of QUALITY_GATES) {
    try {
      const { stdout, stderr } = await execute('npm', gate.args);
      results.push({ name: gate.name, ok: true, output: `${stdout}${stderr}`.slice(-2000) });
    } catch (error) {
      // Bounded-execution timeouts are control flow, not gate verdicts: let
      // them propagate so callers report TIMEOUT instead of a generic gate
      // failure. Every other failure stops at the first failing gate.
      if (isWorkerTimeout(error)) {
        throw error;
      }
      const output = error instanceof Error ? error.message.slice(-2000) : String(error);
      results.push({ name: gate.name, ok: false, output });
      break;
    }
  }
  return results;
}

export function qualityGatesPass(results: GateResult[]): boolean {
  return results.length === QUALITY_GATES.length && results.every((gate) => gate.ok);
}
