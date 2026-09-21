import { describe, expect, it } from 'vitest';
import { resolveEffectiveConfig } from './config.js';
import {
  LOCAL_PROFILE,
  NON_SECRET_VAR_NAMES,
  PRODUCTION_PROFILE,
  SANDBOX_PROFILE,
} from './profiles.js';

// Seam under test (ticket #77): the environment configuration boundary for
// the two canonical non-secret auth action URL slots. Empty means the
// service-owned fallback page; configured values must be absolute http(s)
// action-page URLs without credentials or fragments. sandbox/production
// custom targets require HTTPS; local/test allow HTTP only for
// localhost/loopback development. No runtime, database or auth engine.
describe('auth action URL configuration', () => {
  it('declares both action URL slots in the complete non-secret vocabulary', () => {
    expect(NON_SECRET_VAR_NAMES as readonly string[]).toContain('AUTH_VERIFY_EMAIL_ACTION_URL');
    expect(NON_SECRET_VAR_NAMES as readonly string[]).toContain('AUTH_RESET_PASSWORD_ACTION_URL');
  });

  it('leaves both slots explicitly unset (fallback) in every versioned profile', () => {
    for (const profile of [LOCAL_PROFILE, SANDBOX_PROFILE, PRODUCTION_PROFILE]) {
      expect(profile.AUTH_VERIFY_EMAIL_ACTION_URL).toBe('');
      expect(profile.AUTH_RESET_PASSWORD_ACTION_URL).toBe('');
    }
  });

  it('accepts empty slots as the service-owned fallback', () => {
    const effective = resolveEffectiveConfig({
      environment: 'local',
      runtime: { AUTH_VERIFY_EMAIL_ACTION_URL: '', AUTH_RESET_PASSWORD_ACTION_URL: '' },
    });
    expect(effective.config.AUTH_VERIFY_EMAIL_ACTION_URL).toBe('');
    expect(effective.config.AUTH_RESET_PASSWORD_ACTION_URL).toBe('');
  });

  it('accepts a custom HTTPS action URL per deployment', () => {
    const effective = resolveEffectiveConfig({
      environment: 'sandbox',
      runtime: {
        AUTH_VERIFY_EMAIL_ACTION_URL: 'https://app.example.com/verify?next=%2Fwelcome',
        AUTH_RESET_PASSWORD_ACTION_URL: 'https://app.example.com/reset',
      },
    });
    expect(effective.config.AUTH_VERIFY_EMAIL_ACTION_URL).toBe(
      'https://app.example.com/verify?next=%2Fwelcome',
    );
    expect(effective.config.AUTH_RESET_PASSWORD_ACTION_URL).toBe('https://app.example.com/reset');
  });

  it('rejects plain HTTP custom targets outside local/test with a redacted error', () => {
    for (const environment of ['sandbox', 'production'] as const) {
      let message = '';
      try {
        resolveEffectiveConfig({
          environment,
          runtime: { AUTH_VERIFY_EMAIL_ACTION_URL: 'http://app.example.com/verify' },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('AUTH_VERIFY_EMAIL_ACTION_URL');
      expect(message).not.toContain('http://app.example.com/verify');
    }
  });

  it('allows HTTP custom targets for localhost/loopback development only', () => {
    for (const host of ['http://localhost:3000/verify', 'http://127.0.0.1:3000/verify']) {
      const effective = resolveEffectiveConfig({
        environment: 'local',
        runtime: { AUTH_VERIFY_EMAIL_ACTION_URL: host },
      });
      expect(effective.config.AUTH_VERIFY_EMAIL_ACTION_URL).toBe(host);
    }
    let message = '';
    try {
      resolveEffectiveConfig({
        environment: 'local',
        runtime: { AUTH_VERIFY_EMAIL_ACTION_URL: 'http://app.example.com/verify' },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('AUTH_VERIFY_EMAIL_ACTION_URL');
    expect(message).not.toContain('http://app.example.com/verify');
  });

  it('rejects credentials, fragments and non-http(s) targets without echoing them', () => {
    const bad = [
      'https://user:pass-secret-marker@example.com/verify',
      'https://app.example.com/verify#fragment-secret-marker',
      'ftp://app.example.com/verify',
      'not-a-url-secret-marker',
    ];
    for (const value of bad) {
      let message = '';
      try {
        resolveEffectiveConfig({
          environment: 'local',
          runtime: { AUTH_RESET_PASSWORD_ACTION_URL: value },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).toContain('AUTH_RESET_PASSWORD_ACTION_URL');
      expect(message).not.toContain('pass-secret-marker');
      expect(message).not.toContain('fragment-secret-marker');
      expect(message).not.toContain('not-a-url-secret-marker');
    }
  });
});
