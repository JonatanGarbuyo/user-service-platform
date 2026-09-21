import { describe, expect, it } from 'vitest';
import {
  checkSecretTextBindings,
  formatSecretBindingsError,
  parseSecretListOutput,
  SECRET_TEXT_TYPE,
  type RemoteSecretBinding,
} from '../../scripts/deploy/secret-bindings.js';
import { requiredWorkerSecrets } from '../../scripts/deploy/secrets.js';

const SANDBOX_REQUIRED = ['BETTER_AUTH_SECRET', 'SMTP_USER', 'SMTP_PASSWORD'];

function binding(
  name: string,
  type: string = SECRET_TEXT_TYPE,
  extra: Record<string, unknown> = {},
): RemoteSecretBinding {
  return { name, type, ...extra };
}

// Ticket #106: `secrets.required` accepts a same-name plaintext Worker `vars`
// entry, so preflight must verify every required name exists specifically as a
// Cloudflare `secret_text` binding (names/types only, never values) before
// `wrangler deploy` and smoke.
describe('secret_text binding verification', () => {
  it('passes when all RCH sandbox required names are secret_text', () => {
    const required = requiredWorkerSecrets({
      environment: 'sandbox',
      vars: { AUTH_MAIL_TRANSPORT: 'smtp' },
    });
    expect(required).toEqual(SANDBOX_REQUIRED);
    const remote = required.map((name) => binding(name));
    expect(checkSecretTextBindings(required, remote)).toEqual(
      required.map((name) => ({ name, status: 'ok' as const })),
    );
  });

  it('fails when one required name is missing', () => {
    const remote = [binding('BETTER_AUTH_SECRET'), binding('SMTP_USER')];
    expect(checkSecretTextBindings(SANDBOX_REQUIRED, remote)).toEqual([
      { name: 'BETTER_AUTH_SECRET', status: 'ok' },
      { name: 'SMTP_USER', status: 'ok' },
      { name: 'SMTP_PASSWORD', status: 'missing' },
    ]);
  });

  it('fails when one required name is a plaintext/other type', () => {
    const remote = [
      binding('BETTER_AUTH_SECRET'),
      binding('SMTP_USER'),
      binding('SMTP_PASSWORD', 'plaintext'),
    ];
    expect(checkSecretTextBindings(SANDBOX_REQUIRED, remote)).toEqual([
      { name: 'BETTER_AUTH_SECRET', status: 'ok' },
      { name: 'SMTP_USER', status: 'ok' },
      { name: 'SMTP_PASSWORD', status: 'wrong-type' },
    ]);
  });

  it('ignores extra unrelated secrets', () => {
    const remote = [...SANDBOX_REQUIRED.map((name) => binding(name)), binding('SOME_OTHER_SECRET')];
    expect(checkSecretTextBindings(SANDBOX_REQUIRED, remote)).toEqual(
      SANDBOX_REQUIRED.map((name) => ({ name, status: 'ok' as const })),
    );
  });

  it('covers the production Resend required set', () => {
    const required = requiredWorkerSecrets({
      environment: 'production',
      vars: { AUTH_MAIL_TRANSPORT: 'resend' },
    });
    expect(required).toEqual(['BETTER_AUTH_SECRET', 'RESEND_API_KEY']);
    const remote = required.map((name) => binding(name));
    expect(checkSecretTextBindings(required, remote).every((entry) => entry.status === 'ok')).toBe(
      true,
    );
    expect(
      checkSecretTextBindings(required, [binding('BETTER_AUTH_SECRET')]).find(
        (entry) => entry.name === 'RESEND_API_KEY',
      ),
    ).toEqual({ name: 'RESEND_API_KEY', status: 'missing' });
  });

  it('never consumes or surfaces value fields', () => {
    const canary = 'canary-secret-value-abcdef123456';
    const remote = SANDBOX_REQUIRED.map((name) =>
      binding(name, SECRET_TEXT_TYPE, { value: canary }),
    );
    const stdout = JSON.stringify(remote);
    const parsed = parseSecretListOutput(stdout);
    expect(parsed).toEqual(SANDBOX_REQUIRED.map((name) => ({ name, type: SECRET_TEXT_TYPE })));
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(canary);
    const failures = checkSecretTextBindings(SANDBOX_REQUIRED, parsed);
    expect(failures.every((entry) => entry.status === 'ok')).toBe(true);
  });

  it('parses only names/types from the provider names/types-only listing', () => {
    const stdout = JSON.stringify([
      { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
      { name: 'SMTP_USER', type: 'secret_text' },
      { name: 'SMTP_PASSWORD', type: 'secret_text' },
    ]);
    expect(parseSecretListOutput(stdout)).toEqual([
      { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
      { name: 'SMTP_USER', type: 'secret_text' },
      { name: 'SMTP_PASSWORD', type: 'secret_text' },
    ]);
  });

  it('rejects non-array provider output without leaking it', () => {
    const canary = 'canary-provider-output-abcdef123456';
    let error: unknown;
    try {
      parseSecretListOutput(JSON.stringify({ value: canary }));
    } catch (error_) {
      error = error_;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(canary);
  });

  it('formats failures with required names/status only', () => {
    const error = formatSecretBindingsError('rch-rugbychampagne-user-service-sandbox', [
      { name: 'BETTER_AUTH_SECRET', status: 'ok' },
      { name: 'SMTP_USER', status: 'missing' },
      { name: 'SMTP_PASSWORD', status: 'wrong-type' },
    ]);
    expect(error.message).toContain('SMTP_USER');
    expect(error.message).toContain('missing');
    expect(error.message).toContain('SMTP_PASSWORD');
    expect(error.message).toContain('secret_text');
    expect(error.message).not.toContain('canary');
  });
});
