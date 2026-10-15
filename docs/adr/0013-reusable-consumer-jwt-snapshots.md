# ADR-0013: Reuse consumer JWT snapshots between editorial page navigations

## Status

Accepted by the operator on 2026-10-14. Decision #149, specification #150,
implementation slices #151 and #152 under product map #146.

## Decision

Use short-lived, application-owned asymmetric JWTs for consumer identity and
future Entitlement snapshots. Preserve the authoritative HttpOnly session for
issuance/renewal and existing cookie-based service/administrative operations.
Consumers reuse a locally persisted token across page navigations; shared
editorial HTML contains neither identity nor credentials and does not require
a session query per page.

POST `/v1/auth/token` issues or renews through the live session and returns a
private, noncacheable token response. GET `/v1/auth/jwks` publishes only public
verification keys with bounded caching. The supported algorithm is fixed;
issuer and audience are stable deployment-owned configuration. Signing keys
persist per deployment in D1 behind the identity adapter. Prefer the pinned
Better Auth JWT capability rather than a new authentication engine or custom
cryptography. Its default whole-user payload is replaced with our explicit
claims contract.

The default token lifetime is 900 seconds, configurable within 1..900, and
never exceeds the authoritative session expiry. Claims contain opaque
`sub`, `iss`, `aud`, integer `iat`/`exp` and `entitlements`; this first
increment emits an empty Entitlement list. Commercial grants, prices and
payment lifecycle are not invented by Identity. Later token issuance must
derive rights from local backend facts and cap a grant-bearing snapshot to
the relevant grant validity. Mercado Pago is never queried by the consumer
for subscription state.

## Consumer contract

The first supported browser transport is a same-origin API gateway configured
by the consumer team, preserving cookies and the original browser Origin.
The service validates cookie-auth mutations explicitly against same-origin
or exact deployment-approved gateway origins and Fetch Metadata. The gateway
does not make arbitrary forwarded headers trustworthy. Direct unrelated-origin
browser calls, cross-site cookies and SSO are outside this increment.

A framework-independent client uses generated OpenAPI types, keeps the access
token and public-key cache in versioned per-tab sessionStorage namespaced by
service/issuer/audience, and shares one controller among scripts/islands.
The renewal credential remains HttpOnly. Script-readable bearer storage is
an explicit XSS trade-off: use a short token lifetime, secure contexts and
the consumer's normal script/CSP controls; never store the renewal credential
there. Full document navigation and reload reuse a valid token. Renewal is
lazy and coalesced; inactive/anonymous pages do not poll Identity.

The client verifies signature and configured claims using cached public keys
for its UI snapshot. Receiving APIs verify independently; browser decisions
are not backend authorization. Key rollover retains old public keys through
outstanding token expiry plus the documented clock tolerance. A bounded
unknown-key refresh is distinct from per-page Identity resolution.

## Consequences

Logout/password reset immediately prevent renewal through revoked sessions.
An already-issued offline token may remain valid until expiry, initially at
most 15 minutes. This bounded snapshot is accepted instead of a database or
revocation lookup on every content navigation. Existing administration and
cookie-session checks keep their authoritative store-based semantics and do
not accept this JWT as administrative authority.

Entitlement validity and token expiry are separate. The consumer owns content
classification, soft paywall, SEO and cache policy. Backend Identity delivery
proceeds before the remaining billing lifecycle decision #147; its completion
must not be reported as working paid subscriptions.

## Alternatives considered

A per-page `/me`/rights lookup gives fresher state but makes read traffic
depend on Identity. Long-lived unrestricted JWTs reduce renewals but enlarge
staleness/revocation exposure. Replacing the current session would also change
accepted administration behavior; retaining it for renewal keeps that contract.

## Acceptance

The real HTTP/D1 path proves issue, public-key verification, renewal and
revocation of further issuance. A shipped-client/real-Worker browser fixture
with separate document URLs proves zero Identity calls during valid-token
navigation/reload. Generated client drift and OpenAPI compatibility checks
protect the external handoff. Exact-HEAD Standards, Spec and CI remain
required; production promotion is separate.
