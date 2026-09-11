import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_POLICY, resolveAuthPolicy } from './policy.js';

// Seam under test: the pure application-owned AuthPolicy resolution
// (ADR-0005). No runtime, database or auth engine is involved.
describe('resolveAuthPolicy', () => {
  it('falls back to the verified-email deployment defaults', () => {
    expect(resolveAuthPolicy({})).toEqual(DEFAULT_AUTH_POLICY);
    expect(DEFAULT_AUTH_POLICY).toMatchObject({
      registrationEnabled: true,
      emailPasswordEnabled: true,
      requireEmailVerification: true,
    });
  });

  it('honours explicit deployment flags', () => {
    expect(
      resolveAuthPolicy({
        AUTH_REGISTRATION_ENABLED: 'false',
        AUTH_EMAIL_PASSWORD_ENABLED: 'false',
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
      }),
    ).toEqual({
      registrationEnabled: false,
      emailPasswordEnabled: false,
      requireEmailVerification: false,
    });
  });

  it('treats unknown values as disabled rather than failing open', () => {
    expect(resolveAuthPolicy({ AUTH_REGISTRATION_ENABLED: 'yes' }).registrationEnabled).toBe(false);
  });
});
