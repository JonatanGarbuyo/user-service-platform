# Consumer tokens runbook

Application-owned short-lived access tokens for cached editorial consumers
(spec #150, ADR-0013, ticket #151). The authoritative HttpOnly cookie session
remains the renewal credential; the JWT is a bounded offline snapshot that
receiving APIs verify with cached public keys and no per-request identity
lookup. Initial tokens grant no paid Entitlements; the framework-independent
consumer client is the follow-on slice (#152).

## Operations

- `POST /v1/auth/token` issues or renews from the live cookie session. The
  request carries no user, claims, issuer or audience. The response holds
  `accessToken`, literal `tokenType: Bearer` and integer Unix `expiresAt`.
  All responses are private, no-store.
- `GET /v1/auth/jwks` publishes the active and retained public verification
  keys as an RFC 7517 set with `Cache-Control: public, max-age=300`.
  Private key material is never published. Failures are not cached.
- The engine auth router is never mounted: no `/api/auth/*` surface exists.
  The JWT alone authorizes no service operation — administrative checks stay
  store-backed and `/v1/me` keeps its cookie-session semantics.

## Cookie renewal vs offline-token revocation

- Sign-out and password reset revoke the renewal session immediately:
  further `POST /v1/auth/token` calls with that session are denied (401).
- An already-issued offline token remains valid until its own `exp`, at most
  15 minutes initially. There is no instant global JWT revocation; this
  bounded snapshot is the accepted trade-off (ADR-0013).
- The service slides the renewal session on activity (pinned engine
  default): a live session normally outlives any outstanding token, and the
  minted `exp` additionally never exceeds the authoritative session expiry.

## Same-origin gateway transport

The supported browser transport is a same-origin API gateway owned by the
consumer team: the browser talks to the consumer origin, which forwards to
this service. Direct unrelated-origin browser calls, cross-site cookies and
full SSO are outside this increment.

Cookie-auth mutations (`POST /v1/auth/register`, `/v1/auth/login`,
`/v1/auth/sign-out`, `/v1/auth/token`) enforce an explicit Origin/Fetch
Metadata guard because the application-owned wrappers call `auth.api`
directly:

- An explicit `Origin` header must equal the request origin or an exact
  configured gateway origin; `null` and unlisted origins are rejected (403).
- Without `Origin`, `Sec-Fetch-Site: cross-site` (or an unknown value) is
  rejected; `same-origin`, `same-site` and `none` are accepted.
- Requests with neither header (curl, tests, server-to-server gateways) are
  accepted as documented non-browser flows.
- There is no wildcard CORS and no trust in arbitrary forwarded-host/origin
  headers.

## Issuer, audience, TTL and key configuration

Non-secret deployment values (see `src/config/profiles.ts`):

- `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE`: stable deployment-owned
  identifiers. Local/test fall back to deterministic local-only defaults;
  sandbox/production fail closed (500) without explicit values. Never
  derived from request or forwarded hosts.
- `AUTH_JWT_TTL_SECONDS`: token lifetime in seconds, `1..900`, default
  `900`. Malformed values fail closed. The minted `exp` is additionally
  capped at the live session expiry.
- `AUTH_GATEWAY_ORIGINS`: comma-separated exact `http(s)` origins accepted
  in addition to the request origin. Empty means same-origin only;
  wildcards, paths, credentials and fragments are rejected.

Signing keys:

- Fixed asymmetric algorithm `EdDSA` (`Ed25519`); durable per-deployment
  key rows in D1 (`jwks` table, additive migration `0002`); stable key ids
  surface as JWT `kid` values, so separate Worker instances with the same
  database reuse keys. No per-request rotation and no shared
  sandbox/production keys.
- Private keys stay encrypted through the engine facility
  (`BETTER_AUTH_SECRET`) and never enter logs or responses.
- Keys are retained indefinitely in this slice, which covers every
  outstanding token lifetime (at most 15 minutes) plus verifier clock
  tolerance. Receiving verifiers should allow ~60 seconds of clock skew and
  refresh unknown `kid` values from `GET /v1/auth/jwks` (bounded,
  distinct from per-page identity queries).

## Claims contract

`sub` (opaque User id), `iss`, `aud`, integer `iat`/`exp`, and
`entitlements: []`. Email, roles, session identifiers/tokens, engine rows
and billing-provider identifiers are excluded. A missing billing
implementation grants nothing: paid Entitlements wait for the commercial
lifecycle decision (#147).
