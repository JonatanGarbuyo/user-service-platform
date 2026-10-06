import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  checkFixCyclePr,
  checkTicketIssue,
  concurrencyGroupFor,
  isAuthorizedAssociation,
  parseAgentCommand,
} from '../../scripts/agent/command-guard.js';

// Seam under test: deterministic GitHub-comment command guard (ticket #29).
// Comment text selects only a fixed allowlist of exact commands and is never
// evaluated as shell, arguments, filenames, refs, or prompts. Authorization,
// fork/base/ref rejection, and concurrency grouping are pure and tested here
// without subprocesses; the workflows invoke the existing `agent:ticket`,
// `address-review`, `review:cycle`, and safe-push flows unchanged.
describe('agent command parsing', () => {
  it('selects /agent-ticket for the exact command', () => {
    expect(parseAgentCommand('/agent-ticket')).toBe('agent-ticket');
  });

  it('selects /agent-fix-cycle for the exact command', () => {
    expect(parseAgentCommand('/agent-fix-cycle')).toBe('agent-fix-cycle');
  });

  it('ignores surrounding whitespace around the exact command', () => {
    expect(parseAgentCommand('  /agent-ticket  \n')).toBe('agent-ticket');
  });

  it('selects the first non-empty line and never evaluates the rest', () => {
    expect(parseAgentCommand('/agent-ticket\nPlease implement this when ready')).toBe(
      'agent-ticket',
    );
  });

  it.each([
    '',
    '   ',
    'please run /agent-ticket',
    '/agent-ticket 11',
    '/agent-ticket #11',
    '/agent-ticket --help',
    '/agent-fix-cycle 28',
    '/agent-fix-cycle --pr 28',
    '/agent-ticket; rm -rf /',
    '$(/agent-ticket)',
    '`/agent-ticket`',
    '/agent-ticketExtra',
    '/agent-fix-cycle-extra',
    '/agent-fix-cycle\n/agent-ticket',
  ])('refuses non-exact command text %s', (body) => {
    expect(parseAgentCommand(body)).toBeUndefined();
  });

  it('is case-sensitive', () => {
    expect(parseAgentCommand('/Agent-Ticket')).toBeUndefined();
  });
});

describe('agent command authorization', () => {
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('authorizes %s actors', (association) => {
    expect(isAuthorizedAssociation(association)).toBe(true);
  });

  it.each([
    'CONTRIBUTOR',
    'CONTRIBUTOR ',
    'FIRST_TIMER',
    'FIRST_TIME_CONTRIBUTOR',
    'NONE',
    '',
    'owner',
    'member',
    'collaborator',
  ])('refuses non-member association %s', (association) => {
    expect(isAuthorizedAssociation(association)).toBe(false);
  });
});

describe('agent-fix-cycle safety boundaries', () => {
  const valid = {
    isPullRequest: true,
    state: 'OPEN',
    isFork: false,
    baseRef: 'main',
    headSha: 'a'.repeat(40),
  };

  it('accepts an open same-repo PR targeting main with an exact HEAD', () => {
    expect(checkFixCyclePr(valid).ok).toBe(true);
  });

  it('refuses fork PRs', () => {
    const result = checkFixCyclePr({ ...valid, isFork: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/fork/i);
    }
  });

  it('refuses non-main bases', () => {
    const result = checkFixCyclePr({ ...valid, baseRef: 'staging' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/main/i);
    }
  });

  it('refuses non-PR comments', () => {
    const result = checkFixCyclePr({ ...valid, isPullRequest: false });

    expect(result.ok).toBe(false);
  });

  it('refuses closed or ambiguous PR state', () => {
    for (const state of ['CLOSED', 'MERGED', '', 'UNKNOWN']) {
      expect(checkFixCyclePr({ ...valid, state }).ok).toBe(false);
    }
  });

  it.each(['', 'abc', 'a'.repeat(39), 'z'.repeat(40), 'HEAD', 'main'])(
    'refuses ambiguous head ref %s',
    (headSha) => {
      const result = checkFixCyclePr({ ...valid, headSha });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/head|sha|ref/i);
      }
    },
  );
});

describe('agent-ticket safety boundaries', () => {
  it('accepts an open ready-for-agent issue', () => {
    expect(
      checkTicketIssue({ isPullRequest: false, state: 'OPEN', labels: ['ready-for-agent'] }).ok,
    ).toBe(true);
  });

  it('refuses comments on pull requests', () => {
    const result = checkTicketIssue({
      isPullRequest: true,
      state: 'OPEN',
      labels: ['ready-for-agent'],
    });

    expect(result.ok).toBe(false);
  });

  it('refuses closed issues', () => {
    const result = checkTicketIssue({
      isPullRequest: false,
      state: 'CLOSED',
      labels: ['ready-for-agent'],
    });

    expect(result.ok).toBe(false);
  });

  it('refuses issues missing the ready-for-agent label', () => {
    const result = checkTicketIssue({
      isPullRequest: false,
      state: 'OPEN',
      labels: ['needs-triage'],
    });

    expect(result.ok).toBe(false);
  });
});

describe('agent command concurrency', () => {
  it('locks ticket runs by issue number', () => {
    expect(concurrencyGroupFor('agent-ticket', 11)).toBe('agent-ticket-issue-11');
  });

  it('locks fix-cycle runs by PR number', () => {
    expect(concurrencyGroupFor('agent-fix-cycle', 28)).toBe('agent-fix-cycle-pr-28');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses non-positive run numbers %s',
    (number) => {
      expect(() => concurrencyGroupFor('agent-ticket', number)).toThrow(/number/i);
    },
  );
});

function readWorkflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

// Location-specific reader: every string-valued `run:` step across all jobs,
// parsed as YAML so comments never satisfy the contract. Covers both `run: |`
// blocks and single-line `run:` steps (for example `run: npm ci`).
function extractRunSteps(workflowText: string): string[] {
  const parsed: unknown = parseYaml(workflowText);
  const doc = asRecord(parsed);
  const jobs = doc === undefined ? undefined : asRecord(doc.jobs);
  if (jobs === undefined) {
    return [];
  }
  const steps: string[] = [];
  for (const job of Object.values(jobs)) {
    const jobRecord = asRecord(job);
    const jobSteps = jobRecord === undefined ? undefined : jobRecord.steps;
    if (!Array.isArray(jobSteps)) {
      continue;
    }
    for (const entry of jobSteps) {
      const step = asRecord(entry);
      if (step !== undefined && typeof step.run === 'string') {
        steps.push(step.run);
      }
    }
  }
  return steps;
}

// Ordered step reader: name/uses/run of every step across all jobs, so
// ordering contracts (checkout -> install -> invoke) are checked against the
// parsed document rather than against raw text.
interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
}

function extractWorkflowSteps(workflowText: string): WorkflowStep[] {
  const parsed: unknown = parseYaml(workflowText);
  const doc = asRecord(parsed);
  const jobs = doc === undefined ? undefined : asRecord(doc.jobs);
  if (jobs === undefined) {
    return [];
  }
  const steps: WorkflowStep[] = [];
  for (const job of Object.values(jobs)) {
    const jobRecord = asRecord(job);
    const jobSteps = jobRecord === undefined ? undefined : jobRecord.steps;
    if (!Array.isArray(jobSteps)) {
      continue;
    }
    for (const entry of jobSteps) {
      const step = asRecord(entry);
      if (step === undefined) {
        continue;
      }
      const parsedStep: WorkflowStep = {};
      if (typeof step.name === 'string') {
        parsedStep.name = step.name;
      }
      if (typeof step.uses === 'string') {
        parsedStep.uses = step.uses;
      }
      if (typeof step.run === 'string') {
        parsedStep.run = step.run;
      }
      steps.push(parsedStep);
    }
  }
  return steps;
}

function runStepsReferenceCommentBody(runSteps: string[]): boolean {
  return runSteps.some((step) => step.includes('github.event.comment.body'));
}

function runStepsInterpolateCommentBody(runSteps: string[]): boolean {
  return runSteps.some((step) => /\$\{\{[^}]*github\.event\.comment\.body[^}]*\}\}/.test(step));
}

describe('agent workflow contracts', () => {
  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'triggers %s from created issue comments with per-target concurrency',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(/issue_comment/);
      expect(workflow).toMatch(/created/);
      expect(workflow).toMatch(/concurrency:/);
      expect(workflow).toMatch(/cancel-in-progress:\s*false/);
    },
  );

  it('locks ticket runs by issue and fix-cycle runs by PR', () => {
    expect(readWorkflow('agent-ticket.yml')).toMatch(/agent-ticket-issue-/);
    expect(readWorkflow('agent-fix-cycle.yml')).toMatch(/agent-fix-cycle-pr-/);
  });

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'grants %s least-privilege permissions without broad write-all',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(/permissions:/);
      expect(workflow).toMatch(/contents:\s*write/);
      expect(workflow).toMatch(/pull-requests:\s*write/);
      expect(workflow).toMatch(/issues:\s*write/);
      expect(workflow).not.toMatch(/pull_request_target/);
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml', 'approve-agent-ci.yml', 'ci.yml'])(
    'pins third-party actions on %s instead of mutable refs',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(/actions\/checkout@v7/);
      expect(workflow).toMatch(/actions\/setup-node@v7/);
      expect(workflow).not.toMatch(/actions\/(checkout|setup-node|upload-artifact)@v[456]/);
      expect(workflow).not.toMatch(/@main|@master/);
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'pins upload-artifact to the maintained line on %s',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(/actions\/upload-artifact@v7/);
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml', 'approve-agent-ci.yml', 'ci.yml'])(
    'resolves the Node baseline from .nvmrc on %s',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(/node-version-file:\s*'.nvmrc'/);
      expect(workflow).not.toMatch(/node-version:\s*'/);
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'requires only OPENCODE_ZEN_API_KEY on %s and no production secrets',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(/OPENCODE_ZEN_API_KEY/);
      expect(workflow).not.toMatch(/secrets\.(CLOUDFLARE|D1_|RESEND|SENDGRID|PROD_|DEPLOY_|NPM_)/i);
      expect(workflow).not.toMatch(/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/i);
      expect(workflow).not.toMatch(/RESEND_API_KEY|SENDGRID_API_KEY|NPM_TOKEN/i);
    },
  );

  it('drives /agent-ticket through the existing agent:ticket flow', () => {
    const workflow = readWorkflow('agent-ticket.yml');

    expect(workflow).toMatch(/npm run agent:ticket/);
    expect(workflow).toMatch(/review:cycle/);
    expect(workflow).toMatch(/\.review-cycle\/latest\.json/);
  });

  it('drives /agent-fix-cycle through address-review, safe-push, and review:cycle', () => {
    const workflow = readWorkflow('agent-fix-cycle.yml');

    expect(workflow).toMatch(/address-review/);
    expect(workflow).toMatch(/safe-push/);
    expect(workflow).toMatch(/review:cycle/);
    expect(workflow).toMatch(/\.review-cycle\/latest\.json/);
  });

  it('pins agent-fix-cycle execution to the validated exact HEAD', () => {
    const workflow = readWorkflow('agent-fix-cycle.yml');
    const checkoutIndex = workflow.indexOf('Check out PR head after authorization');

    expect(checkoutIndex).toBeGreaterThan(-1);
    expect(workflow).toMatch(/steps\.guard\.outputs\.head/);
    expect(workflow).toMatch(/git rev-parse HEAD/);
    expect(workflow).toMatch(/AGENT-FIX-CYCLE REFUSED/);
    const verificationIndex = workflow.indexOf('Verify checked-out HEAD matches validated OID');
    expect(verificationIndex).toBeGreaterThan(checkoutIndex);
    const addressReviewIndex = workflow.indexOf('Run address-review correction');
    expect(verificationIndex).toBeGreaterThan(-1);
    expect(verificationIndex).toBeLessThan(addressReviewIndex);
  });

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'installs dependencies for the checked-out tree after the last checkout before agent commands on %s',
    (name) => {
      const steps = extractWorkflowSteps(readWorkflow(name));
      const invocations = steps.filter((step) => /\bnpm run \S/.test(step.run ?? ''));

      // Fail closed: the invariant must never pass vacuously.
      expect(invocations.length).toBeGreaterThan(0);
      for (const invocation of invocations) {
        const invokeIndex = steps.indexOf(invocation);
        let lastCheckout = -1;
        for (let index = 0; index < invokeIndex; index += 1) {
          if (steps[index]?.uses?.startsWith('actions/checkout')) {
            lastCheckout = index;
          }
        }
        const installIndex = steps.findIndex(
          (step, index) =>
            index > lastCheckout && index < invokeIndex && step.run?.trim() === 'npm ci',
        );
        expect(installIndex).toBeGreaterThan(-1);
        expect(installIndex).toBeGreaterThan(lastCheckout);
      }
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'never merges, deploys, publishes, or pushes main on %s',
    (name) => {
      const workflow = readWorkflow(name).toLowerCase();

      expect(workflow).not.toContain('gh pr merge');
      expect(workflow).not.toContain('wrangler deploy');
      expect(workflow).not.toContain('npm publish');
      expect(workflow).not.toContain('push origin main');
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'covers every run step including terminal and single-line runs on %s',
    (name) => {
      const runSteps = extractRunSteps(readWorkflow(name));

      // Fail closed: the ban below must never pass vacuously.
      expect(runSteps.length).toBeGreaterThan(0);
      // Single-line `run:` steps are part of the contract surface.
      expect(runSteps).toContain('npm ci');
      // The terminal status step carries the most `${{ }}` interpolations and
      // posts with `issues: write`; it must be inside the ban surface.
      expect(runSteps.some((step) => step.includes('workflow did not reach READY'))).toBe(true);
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'rejects injected comment-body references in the terminal and single-line runs on %s',
    (name) => {
      const runSteps = extractRunSteps(readWorkflow(name));
      const terminal = runSteps.find((step) => step.includes('workflow did not reach READY'));
      expect(terminal).toBeDefined();

      const withTerminalInjection = [
        ...runSteps,
        `${terminal ?? ''}\necho $` + '{{ github.event.comment.body }}',
      ];
      expect(runStepsInterpolateCommentBody(withTerminalInjection)).toBe(true);
      expect(runStepsReferenceCommentBody(withTerminalInjection)).toBe(true);

      const withSingleLineInjection = runSteps.map((step) =>
        step === 'npm ci' ? 'echo $' + '{{ github.event.comment.body }}' : step,
      );
      expect(withSingleLineInjection).not.toContain('npm ci');
      expect(runStepsInterpolateCommentBody(withSingleLineInjection)).toBe(true);
      expect(runStepsReferenceCommentBody(withSingleLineInjection)).toBe(true);
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'never interpolates raw comment text into shell run steps on %s',
    (name) => {
      const workflow = readWorkflow(name);
      const runSteps = extractRunSteps(workflow);

      // Ticket #82: the cheap job-level `if:` prefilter may read
      // `github.event.comment.body` as an Actions expression (no shell
      // interpolation). Shell `run:` blocks must still read comment text only
      // through `$GITHUB_EVENT_PATH`, never via expression interpolation.
      expect(workflow).toMatch(/github\.event\.comment\.body/);
      expect(runStepsReferenceCommentBody(runSteps)).toBe(false);
      // Comment body must never be interpolated as an expression inside a
      // shell step; only the job-level `if:` may reference it.
      expect(runStepsInterpolateCommentBody(runSteps)).toBe(false);
    },
  );

  describe('deterministic OpenCode installation (ticket #66)', () => {
    it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
      'installs the pinned OpenCode version through npm on %s',
      (name) => {
        const workflow = readWorkflow(name);

        expect(workflow).toMatch(/npm install -g opencode-ai@1\.18\.30/);
      },
    );

    it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
      'verifies the installed CLI version before invoking it on %s',
      (name) => {
        const workflow = readWorkflow(name);
        const installIndex = workflow.indexOf('Install pinned OpenCode');

        expect(installIndex).toBeGreaterThan(-1);
        const installSection = workflow.slice(installIndex);
        expect(installSection).toMatch(/opencode --version/);
        expect(installSection).toMatch(/1\.18\.30/);
        const verifyIndex = installSection.indexOf('opencode --version');
        // agent-ticket invokes through `npm run agent:ticket` (which spawns
        // `opencode run` internally); agent-fix-cycle invokes the initial
        // correction through the deterministic evidence-capable seam
        // `npm run agent:fix-cycle-correction` (ticket #116, which spawns
        // `opencode run` internally). Search after the install step so the
        // acknowledge comment (which names the flow) is not mistaken for the
        // invocation.
        const tail = workflow.slice(installIndex);
        const directInvoke = tail.indexOf('opencode run');
        const ticketInvoke = tail.indexOf('npm run agent:ticket', verifyIndex);
        const fixCycleInvoke = tail.indexOf('npm run agent:fix-cycle-correction', verifyIndex);
        const invokeIndex =
          directInvoke === -1 ? Math.max(ticketInvoke, fixCycleInvoke) : directInvoke;
        expect(verifyIndex).toBeGreaterThan(-1);
        expect(invokeIndex).toBeGreaterThan(-1);
        expect(verifyIndex).toBeLessThan(invokeIndex);
      },
    );

    it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
      'never uses the unsupported curl installer version flag on %s',
      (name) => {
        const workflow = readWorkflow(name);

        expect(workflow).not.toMatch(/opencode\.ai\/install/);
        expect(workflow).not.toMatch(/bash -s -- --version/);
        expect(workflow).not.toMatch(/\.opencode\/bin/);
      },
    );
  });
});
