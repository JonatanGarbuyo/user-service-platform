// Isolated test-time control for the real review-cycle CLI suite (ticket #144).
//
// Activated only inside the explicitly spawned test CLI child via
// `REVIEW_CYCLE_ACCELERATE_POLL=1` plus `NODE_OPTIONS=--import <this file>` in
// that child's environment. The parent vitest process and normal production
// invocations never set the flag, so the helper is a no-op there.
//
// When active, only the known CI polling sleep (`10_000ms`, the shipped
// `CHECK_POLL_DELAY_MS`) is accelerated to a short local delay and its
// original requested duration is appended to `REVIEW_CYCLE_POLL_LOG`. Every
// other timer keeps its original duration, callback arguments and handle
// semantics by delegating to the captured `setTimeout`.
import { appendFileSync } from 'node:fs';

const ACCELERATE_FLAG = globalThis.process.env.REVIEW_CYCLE_ACCELERATE_POLL;
if (ACCELERATE_FLAG === '1') {
  const KNOWN_CI_POLL_DELAY_MS = 10000;
  const ACCELERATED_DELAY_MS = 10;
  const originalSetTimeout = globalThis.setTimeout;
  const acceleratedSetTimeout = function (callback, delay, ...args) {
    if (delay === KNOWN_CI_POLL_DELAY_MS) {
      const logPath = globalThis.process.env.REVIEW_CYCLE_POLL_LOG;
      if (typeof logPath === 'string' && logPath !== '') {
        appendFileSync(logPath, `${String(delay)}\n`);
      }
      return Reflect.apply(originalSetTimeout, this, [callback, ACCELERATED_DELAY_MS, ...args]);
    }
    return Reflect.apply(originalSetTimeout, this, [callback, delay, ...args]);
  };
  globalThis.setTimeout = acceleratedSetTimeout;
}
