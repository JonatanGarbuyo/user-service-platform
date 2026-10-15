import { describe, expect, it } from 'vitest';
import { evaluateCookieMutationOrigin, resolveGatewayOrigins } from './origin-guard.js';

// Seam under test: the pure application-owned Origin/Fetch Metadata guard
// for cookie-auth mutation operations (spec #150, ADR-0013). The wrappers
// call `auth.api` directly, so engine-router CSRF middleware cannot be
// assumed; this boundary accepts legitimate same-origin and exact configured
// gateway origins, rejects hostile/null origins and inconsistent cross-site
// metadata, and preserves headerless non-browser flows. No runtime, database
// or auth engine is involved.
describe('resolveGatewayOrigins', () => {
  it('resolves no extra origins when the slot is explicitly unset', () => {
    expect(resolveGatewayOrigins(undefined)).toEqual([]);
    expect(resolveGatewayOrigins('')).toEqual([]);
    expect(resolveGatewayOrigins('   ')).toEqual([]);
  });

  it('parses exact comma-separated gateway origins', () => {
    expect(resolveGatewayOrigins('https://shop.example, https://www.example:8443')).toEqual([
      'https://shop.example',
      'https://www.example:8443',
    ]);
  });

  it('rejects wildcards, paths, credentials, fragments and non-http schemes', () => {
    for (const raw of [
      '*',
      'https://*.example',
      'https://example/path',
      'https://example?x=1',
      'https://user@example',
      'https://example#frag',
      'ftp://example',
      'null',
      'not-an-origin',
    ]) {
      expect(() => resolveGatewayOrigins(raw)).toThrow(/AUTH_GATEWAY_ORIGINS/);
    }
  });

  it('never echoes configured values in validation errors', () => {
    let message = '';
    try {
      resolveGatewayOrigins('https://evil-marker.example/path');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('evil-marker');
  });
});

describe('evaluateCookieMutationOrigin', () => {
  const serviceOrigin = 'https://service.example';

  it('accepts headerless non-browser flows such as curl, tests and server gateways', () => {
    expect(
      evaluateCookieMutationOrigin({
        requestOrigin: serviceOrigin,
        origin: null,
        secFetchSite: null,
        gatewayOrigins: [],
      }),
    ).toBe(true);
  });

  it('accepts legitimate same-origin browser requests', () => {
    expect(
      evaluateCookieMutationOrigin({
        requestOrigin: serviceOrigin,
        origin: serviceOrigin,
        secFetchSite: 'same-origin',
        gatewayOrigins: [],
      }),
    ).toBe(true);
  });

  it('accepts exact configured gateway origins', () => {
    expect(
      evaluateCookieMutationOrigin({
        requestOrigin: serviceOrigin,
        origin: 'https://shop.example',
        secFetchSite: 'cross-site',
        gatewayOrigins: ['https://shop.example'],
      }),
    ).toBe(true);
  });

  it('rejects hostile, null and unlisted origins', () => {
    for (const origin of [
      'https://evil.example',
      'null',
      'https://service.example.evil.example',
      'https://service.example:8443',
      'http://service.example',
    ]) {
      expect(
        evaluateCookieMutationOrigin({
          requestOrigin: serviceOrigin,
          origin,
          secFetchSite: 'same-origin',
          gatewayOrigins: ['https://shop.example'],
        }),
      ).toBe(false);
    }
  });

  it('rejects inconsistent cross-site fetch metadata without an allowlisted origin', () => {
    expect(
      evaluateCookieMutationOrigin({
        requestOrigin: serviceOrigin,
        origin: null,
        secFetchSite: 'cross-site',
        gatewayOrigins: [],
      }),
    ).toBe(false);
  });

  it('accepts same-origin, same-site and navigation fetch metadata without an origin', () => {
    for (const secFetchSite of ['same-origin', 'same-site', 'none']) {
      expect(
        evaluateCookieMutationOrigin({
          requestOrigin: serviceOrigin,
          origin: null,
          secFetchSite,
          gatewayOrigins: [],
        }),
      ).toBe(true);
    }
  });

  it('fails closed on unknown fetch-metadata values', () => {
    expect(
      evaluateCookieMutationOrigin({
        requestOrigin: serviceOrigin,
        origin: null,
        secFetchSite: 'super-future-value',
        gatewayOrigins: [],
      }),
    ).toBe(false);
  });
});
