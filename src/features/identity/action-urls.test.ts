import { describe, expect, it } from 'vitest';
import {
  RESET_PASSWORD_ACTION_PATH,
  VERIFY_EMAIL_ACTION_PATH,
  buildAuthActionUrl,
} from './action-urls.js';

// Seam under test (ticket #77): the pure application-owned action-URL builder
// above the Better Auth boundary. It combines a configured consumer action page
// (or the service-owned fallback path on the request origin) with the Better
// Auth token into exactly one `token` query parameter. No Better Auth engine,
// database or HTTP runtime is involved.
describe('buildAuthActionUrl', () => {
  it('targets the service-owned fallback route on the request origin when unconfigured', () => {
    const url = buildAuthActionUrl({
      varName: 'AUTH_VERIFY_EMAIL_ACTION_URL',
      configured: '',
      requestOrigin: 'http://localhost:8787',
      fallbackPath: VERIFY_EMAIL_ACTION_PATH,
      token: 'verify-token-123',
    });

    expect(url).toBe('http://localhost:8787/auth-actions/verify-email?token=verify-token-123');
  });

  it('uses the reset fallback path for password-reset actions', () => {
    const url = buildAuthActionUrl({
      varName: 'AUTH_RESET_PASSWORD_ACTION_URL',
      configured: '',
      requestOrigin: 'http://localhost:8787',
      fallbackPath: RESET_PASSWORD_ACTION_PATH,
      token: 'reset-token-123',
    });

    expect(url).toBe('http://localhost:8787/auth-actions/reset-password?token=reset-token-123');
  });

  it('uses a configured consumer action page verbatim and sets a single token parameter', () => {
    const url = buildAuthActionUrl({
      varName: 'AUTH_VERIFY_EMAIL_ACTION_URL',
      configured: 'https://app.example.com/verify',
      requestOrigin: 'http://localhost:8787',
      fallbackPath: VERIFY_EMAIL_ACTION_PATH,
      token: 'abc-123',
    });

    expect(url).toBe('https://app.example.com/verify?token=abc-123');
  });

  it('preserves unrelated configured query parameters while replacing any stale token', () => {
    const url = buildAuthActionUrl({
      varName: 'AUTH_VERIFY_EMAIL_ACTION_URL',
      configured: 'https://app.example.com/start?next=%2Fwelcome&token=stale-token',
      requestOrigin: 'http://localhost:8787',
      fallbackPath: VERIFY_EMAIL_ACTION_PATH,
      token: 'fresh-token',
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://app.example.com/start');
    expect(parsed.searchParams.get('token')).toBe('fresh-token');
    expect(parsed.searchParams.get('next')).toBe('/welcome');
    expect(parsed.searchParams.getAll('token')).toHaveLength(1);
  });

  it('trims surrounding whitespace on configured values', () => {
    const url = buildAuthActionUrl({
      varName: 'AUTH_VERIFY_EMAIL_ACTION_URL',
      configured: '  https://app.example.com/verify  ',
      requestOrigin: 'http://localhost:8787',
      fallbackPath: VERIFY_EMAIL_ACTION_PATH,
      token: 'abc-123',
    });

    expect(url).toBe('https://app.example.com/verify?token=abc-123');
  });

  it('names the canonical variable in redacted errors without echoing the value', () => {
    let message = '';
    try {
      buildAuthActionUrl({
        varName: 'AUTH_VERIFY_EMAIL_ACTION_URL',
        configured: 'not-a-url-secret-marker',
        requestOrigin: 'http://localhost:8787',
        fallbackPath: VERIFY_EMAIL_ACTION_PATH,
        token: 'abc-123',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain('AUTH_VERIFY_EMAIL_ACTION_URL');
    expect(message).not.toContain('not-a-url-secret-marker');
    expect(message).not.toContain('abc-123');
  });

  it('rejects configured URLs with credentials or fragments without echoing them', () => {
    for (const configured of [
      'https://user:pass-secret-marker@example.com/verify',
      'https://app.example.com/verify#fragment-secret-marker',
    ]) {
      let message = '';
      try {
        buildAuthActionUrl({
          varName: 'AUTH_RESET_PASSWORD_ACTION_URL',
          configured,
          requestOrigin: 'http://localhost:8787',
          fallbackPath: RESET_PASSWORD_ACTION_PATH,
          token: 'abc-123',
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).toContain('AUTH_RESET_PASSWORD_ACTION_URL');
      expect(message).not.toContain('pass-secret-marker');
      expect(message).not.toContain('fragment-secret-marker');
    }
  });
});
