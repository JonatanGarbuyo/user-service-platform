// Explicit Origin/Fetch Metadata protection for cookie-auth mutation
// operations (spec #150, ADR-0013). Application-owned wrappers call
// `auth.api` directly, so engine-router CSRF middleware cannot be assumed to
// apply. This boundary accepts legitimate same-origin requests and exact
// configured gateway origins, rejects hostile/null origins and inconsistent
// cross-site metadata, and preserves documented headerless non-browser flows
// (curl, tests, server-to-server gateways). No wildcard CORS or arbitrary
// forwarded-origin trust: only the request origin and exact
// deployment-owned gateway origins are ever accepted.
export interface CookieMutationOriginInput {
  // The service origin derived from the request URL (never a forwarded host).
  readonly requestOrigin: string;
  // Raw `Origin` request header value, or null when absent.
  readonly origin: string | null;
  // Raw `Sec-Fetch-Site` request header value, or null when absent.
  readonly secFetchSite: string | null;
  // Exact deployment-owned gateway origins (empty means same-origin only).
  readonly gatewayOrigins: readonly string[];
}

// Parses the comma-separated AUTH_GATEWAY_ORIGINS slot into exact origins.
// Each entry must be an absolute http(s) origin without credentials, path,
// query or fragment; wildcards and reflected values are rejected. Failures
// name only the variable and the expected shape, never the supplied value.
export function resolveGatewayOrigins(raw: string | undefined): string[] {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return [];
  }
  const origins = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (origins.length === 0) {
    return [];
  }
  for (const origin of origins) {
    if (!isExactHttpOrigin(origin)) {
      throw new Error(
        'Configuration error: AUTH_GATEWAY_ORIGINS must be a comma-separated list of exact http(s) origins without credentials, paths or wildcards.',
      );
    }
  }
  return origins;
}

function isExactHttpOrigin(value: string): boolean {
  // Wildcards are never exact origins.
  if (value.includes('*')) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    return false;
  }
  // Re-serialization must round-trip exactly: no trailing slashes, default
  // ports, case folding or other normalization surprises.
  return parsed.origin === value;
}

// Evaluates one cookie-auth mutation request. An explicit `Origin` header
// must match the request origin or an exact configured gateway origin;
// otherwise `Sec-Fetch-Site`, when present, must not claim a cross-site
// context. Requests with neither header are headerless non-browser flows
// and are accepted.
export function evaluateCookieMutationOrigin(input: CookieMutationOriginInput): boolean {
  const allowed = new Set<string>([input.requestOrigin, ...input.gatewayOrigins]);
  if (input.origin !== null && input.origin.trim().length > 0) {
    return allowed.has(input.origin.trim());
  }
  if (input.secFetchSite !== null && input.secFetchSite.trim().length > 0) {
    const site = input.secFetchSite.trim().toLowerCase();
    if (site === 'same-origin' || site === 'same-site' || site === 'none') {
      return true;
    }
    return false;
  }
  return true;
}
