import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_STAGES,
  assertSafeLocalAcceptanceTarget,
  formatAcceptanceSummary,
  requireEmailActionToken,
  resolveEmailActionToken,
  resolveLocalAcceptanceConfig,
} from '../../scripts/local-acceptance.js';

// Seam under test (ticket #60, spec #8): pure operator-input resolution,
// target guards, and non-secret evidence formatting for the local Identity
// release acceptance runner. No network, no Worker, no real mail, no secrets
// on disk; failures name variables and shapes, never values.
describe('local acceptance operator inputs', () => {
  it('resolves explicit operator inputs with a localhost default target', () => {
    expect(
      resolveLocalAcceptanceConfig({
        ACCEPTANCE_EMAIL: 'acceptance@example.com',
        ACCEPTANCE_PASSWORD: 'correct-horse-60',
        ACCEPTANCE_NEW_PASSWORD: 'correct-horse-61',
        ACCEPTANCE_VERIFICATION_TOKEN: 'verification-token',
        ACCEPTANCE_RESET_TOKEN: 'reset-token',
      }),
    ).toEqual({
      baseUrl: 'http://localhost:8787',
      email: 'acceptance@example.com',
      password: 'correct-horse-60',
      newPassword: 'correct-horse-61',
      verificationToken: 'verification-token',
      resetToken: 'reset-token',
    });
  });

  it.each([['ACCEPTANCE_EMAIL'], ['ACCEPTANCE_PASSWORD'], ['ACCEPTANCE_NEW_PASSWORD']])(
    'fails closed without %s and never echoes values',
    (missing) => {
      const env = {
        ACCEPTANCE_EMAIL: 'acceptance@example.com',
        ACCEPTANCE_PASSWORD: 'correct-horse-60',
        ACCEPTANCE_NEW_PASSWORD: 'correct-horse-61',
        ACCEPTANCE_VERIFICATION_TOKEN: 'verification-token',
        ACCEPTANCE_RESET_TOKEN: 'reset-token',
        [missing]: '',
      };
      let message = '';
      try {
        resolveLocalAcceptanceConfig(env);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toContain(missing);
      expect(message).not.toContain('correct-horse-60');
      expect(message).not.toContain('acceptance@example.com');
      expect(message).not.toContain('verification-token');
    },
  );

  it('starts a fresh-DB run without upfront email-action tokens', () => {
    expect(
      resolveLocalAcceptanceConfig({
        ACCEPTANCE_EMAIL: 'acceptance@example.com',
        ACCEPTANCE_PASSWORD: 'correct-horse-60',
        ACCEPTANCE_NEW_PASSWORD: 'correct-horse-61',
      }),
    ).toEqual({
      baseUrl: 'http://localhost:8787',
      email: 'acceptance@example.com',
      password: 'correct-horse-60',
      newPassword: 'correct-horse-61',
      verificationToken: undefined,
      resetToken: undefined,
    });
  });

  it('resolves optional email-action tokens from the environment without echoing values', () => {
    expect(
      resolveEmailActionToken(
        { ACCEPTANCE_VERIFICATION_TOKEN: '  verification-token  ' },
        'ACCEPTANCE_VERIFICATION_TOKEN',
      ),
    ).toBe('verification-token');
    expect(resolveEmailActionToken({}, 'ACCEPTANCE_VERIFICATION_TOKEN')).toBeUndefined();
    expect(
      resolveEmailActionToken({ ACCEPTANCE_RESET_TOKEN: '' }, 'ACCEPTANCE_RESET_TOKEN'),
    ).toBeUndefined();
  });

  it('requires an email-action token at its stage and never echoes values', () => {
    expect(requireEmailActionToken('verification-token', 'ACCEPTANCE_VERIFICATION_TOKEN')).toBe(
      'verification-token',
    );
    let message = '';
    try {
      requireEmailActionToken(undefined, 'ACCEPTANCE_VERIFICATION_TOKEN');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('ACCEPTANCE_VERIFICATION_TOKEN');
    expect(message).not.toContain('verification-token');
  });

  it('refuses non-localhost targets so real credentials cannot reach a deployment', () => {
    expect(() => assertSafeLocalAcceptanceTarget('not-a-url')).toThrow();
    expect(() => assertSafeLocalAcceptanceTarget('ftp://example.com')).toThrow();
    expect(() => assertSafeLocalAcceptanceTarget('https://sandbox.example.workers.dev')).toThrow(
      /local/i,
    );
    expect(assertSafeLocalAcceptanceTarget('http://localhost:8787').origin).toBe(
      'http://localhost:8787',
    );
    expect(assertSafeLocalAcceptanceTarget('http://127.0.0.1:8787').origin).toBe(
      'http://127.0.0.1:8787',
    );
  });
});

describe('local acceptance evidence', () => {
  it('covers the executed HTTP stages without advertising operator prerequisites', () => {
    expect(ACCEPTANCE_STAGES).toEqual([
      'health',
      'me-anonymous',
      'register',
      'login-unverified',
      'verify-email',
      'login-verified',
      'me-authenticated',
      'sign-out',
      'me-after-sign-out',
      'request-password-reset',
      'reset-password',
      'login-old-rejected',
      'login-new',
      'admin-bootstrap',
    ]);
  });

  it('formats a non-secret summary that identifies the commit and per-stage outcome', () => {
    const summary = formatAcceptanceSummary({
      commit: 'abc123def456',
      transport: 'smtp',
      results: [
        { stage: 'health', status: 200, outcome: 'pass' },
        { stage: 'register', status: 201, outcome: 'pass' },
      ],
      success: true,
    });
    expect(summary.commit).toBe('abc123def456');
    expect(summary.success).toBe(true);
    expect(summary.eligibility).toBe('eligible');
    expect(summary.stages).toEqual(['health', 'register']);
    expect(summary.stageResults).toEqual([
      { stage: 'health', status: 200, outcome: 'pass' },
      { stage: 'register', status: 201, outcome: 'pass' },
    ]);
    expect(JSON.stringify(summary)).not.toContain('correct-horse-60');
  });

  it('marks any failed run ineligible with no partial-success interpretation', () => {
    const summary = formatAcceptanceSummary({
      commit: 'abc123def456',
      transport: 'smtp',
      results: [{ stage: 'health', status: 200, outcome: 'pass' }],
      success: false,
    });
    expect(summary.success).toBe(false);
    expect(summary.eligibility).toBe('ineligible');
  });
});
