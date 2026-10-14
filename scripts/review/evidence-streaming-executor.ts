// Evidence-streaming worker executor shared by review-cycle Standards, Spec
// and loop-correction workers (tickets #116, #127, #138).
//
// This module is the single shipped implementation: `scripts/review-cycle.ts`
// imports this exact function for all three review/correction invocation
// types. Tests invoke this same export directly with real worker subprocesses
// instead of mirroring its try/catch/finalize chain.
//
// Collection is best-effort and additive: persistence failures and incomplete
// coverage never change the worker outcome, reviewer markers, gates or
// exact-HEAD CI. Reported retryability has no execution authority.
import {
  buildEvidenceInvocation,
  commandSessionExporter,
  createEvidenceCapture,
  finalizeSkillEvidence,
  suppressJsonWorkerLines,
  type PersistEvidenceDeps,
  type SessionExporter,
} from './evidence-worker.js';
import type { CommandExecutor } from './runner.js';
import type { RunSummaryRecorder } from './run-summary.js';
import { runWorkerStream, type SpawnFn } from './worker-stream.js';
import { timeoutForWorker, type WorkerLabel } from './worker-timeout.js';

export interface EvidenceStreamingEvidence {
  command: string;
  axis: string;
  attempt: number;
  workerStartHead: string;
}

export interface EvidenceStreamingExecutorDeps {
  timeoutMs?: number;
  spawnFn?: SpawnFn;
  persistDeps?: PersistEvidenceDeps;
  exporter?: SessionExporter;
  killGraceMs?: number;
  groupPollMs?: number;
}

export function evidenceStreamingWorkerExecutor(
  label: WorkerLabel,
  evidence: EvidenceStreamingEvidence,
  recorder: RunSummaryRecorder,
  deps: EvidenceStreamingExecutorDeps = {},
): CommandExecutor {
  return async (command, args) => {
    const capture = createEvidenceCapture();
    const settle = async (): Promise<void> => {
      try {
        const result = await finalizeSkillEvidence(
          {
            invocation: buildEvidenceInvocation({
              worker: 'review-cycle',
              command: evidence.command,
              axis: evidence.axis,
              attempt: evidence.attempt,
              workerStartHead: evidence.workerStartHead,
            }),
            lines: capture.lines,
            exporter: deps.exporter ?? commandSessionExporter(),
            truncatedStream: capture.wasTruncated(),
          },
          deps.persistDeps ?? {},
        );
        if (result.evidencePath !== undefined) {
          recorder.recordSkillEvidencePath(result.evidencePath);
        }
      } catch {
        // Best-effort: evidence collection never changes the worker outcome.
      }
    };
    try {
      const result = await runWorkerStream(
        command,
        args,
        {
          label,
          timeoutMs: deps.timeoutMs ?? timeoutForWorker(label),
          stdoutLogFilter: suppressJsonWorkerLines,
          ...(deps.killGraceMs === undefined ? {} : { killGraceMs: deps.killGraceMs }),
          ...(deps.groupPollMs === undefined ? {} : { groupPollMs: deps.groupPollMs }),
        },
        deps.spawnFn,
        {
          onStdoutLine: (line) => {
            capture.pushLine(line);
          },
        },
      );
      await settle();
      return result;
    } catch (error) {
      await settle();
      throw error;
    }
  };
}
