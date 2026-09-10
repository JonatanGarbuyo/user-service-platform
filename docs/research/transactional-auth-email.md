# Research: transactional authentication email

## Question

How should authentication email be delivered without coupling Better Auth or application feature slices to a specific transport/provider?

## Primary sources

- Better Auth email concepts: https://better-auth.com/docs/concepts/email
- Better Auth email/password: https://better-auth.com/docs/authentication/email-password
- Better Auth options: https://better-auth.com/docs/reference/options
- Better Auth user/email change: https://better-auth.com/docs/concepts/users-accounts
- Cloudflare Email Service: https://developers.cloudflare.com/email-service/
- Cloudflare Email Sending Workers API: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
- Cloudflare Email Service pricing: https://developers.cloudflare.com/email-service/platform/pricing/
- Cloudflare Email Service limits: https://developers.cloudflare.com/email-service/platform/limits/
- Resend Cloudflare integration: https://resend.com/cloudflare
- Resend pricing: https://resend.com/pricing/

## Findings

### Better Auth deliberately brings no required email provider

Better Auth accepts application callbacks for verification and password-reset delivery and documents a bring-your-own-provider model. It recommends not awaiting outbound email in the authentication request because response timing can leak information, and explicitly recommends `waitUntil`-style execution on serverless runtimes.

The same email-verification callback is used when verifying a newly changed email. Better Auth can additionally require confirmation at the current address before the change proceeds. Password-reset flows can revoke existing sessions through configuration.

### Email transport should not define our auth contract

Better Auth gives callbacks a recipient plus a generated verification/reset URL/token. The application can translate those callbacks into purpose-specific mailer operations. Feature/domain code should not construct provider-specific payloads, and the provider should not receive business objects beyond the fields required to render/send the message.

### Cloudflare Email Service is attractive but still Beta

Cloudflare Email Service now supports outbound transactional email directly from Workers through a native binding. With a sending domain onboarded and Workers Paid, it can send to arbitrary recipients. Current published pricing includes 3,000 outbound emails per month and usage-based overage. It is especially attractive here because the application already runs on Workers and would not need an API key for a third-party email provider when using a binding.

However, Cloudflare still labels Email Sending as Beta. Authentication verification and recovery are critical service paths, so adopting it as the production default should be an explicit risk decision rather than an incidental consequence of the Cloudflare stack.

### Mature external providers remain simple on Workers

Resend documents direct Cloudflare Workers integration and provides a stable HTTP/API-based transactional email service. Other providers such as Postmark or SES can also fit behind the same transport interface. Provider choice therefore does not need to leak into Better Auth configuration, HTTP contracts, or feature slices.

## Decision: application-owned mailer boundary

Define a purpose-specific `AuthMailer` application interface rather than exposing a generic provider `sendEmail` call throughout the codebase. The conceptual operations are:

- send email verification;
- send password reset;
- send current-address confirmation for email change when that policy is enabled;
- send new-address verification through the normal verification operation.

Inputs are minimal value objects such as recipient, action URL, expiry metadata, application/branding data, and a correlation/message id. Better Auth callbacks adapt into these operations.

`AuthMailer` owns template selection. A lower-level transport adapter owns provider/binding mechanics. Provider SDK types never cross the adapter boundary.

Templates are deployment-brandable and produce both HTML and plain-text bodies. Tokens/action URLs are template inputs only; they must never be emitted into logs or generic domain events.

## Decision: request-path behavior

Authentication endpoints do not await the external email send. On Workers, delivery is scheduled through the request execution context (`waitUntil`) so the HTTP response is not coupled to provider latency and timing behavior does not reveal whether an account exists.

The initial version does not add Cloudflare Queues solely for auth email. Verification/reset flows already support user-triggered resend, and a queue would introduce another operational resource plus at-least-once duplicate-delivery semantics. Add a durable queue later only if measured provider failures or delivery requirements justify it.

Email delivery failures are logged as structured operational events with purpose, provider/transport identifier, correlation id and safe internal user/message identifiers. Logs must not contain the recipient action URL/token, body, credentials, or provider secret.

## Decision: local and staging safety

The mail transport is environment-specific.

- Tests use an in-memory/fake transport whose captured messages are accessible only to the test process.
- Local development uses a development sink/transport and must never silently inherit production email credentials.
- Staging defaults to a recipient allowlist or sandbox transport so test flows cannot email arbitrary real users.
- Production uses an explicitly configured production transport and sender domain.

Environment startup/config validation must fail closed if an environment requiring real email is missing its required transport configuration.

## Decision: production provider seam

Provider selection is a deployment decision behind the transport adapter. The first production adapter should be chosen deliberately rather than making Better Auth depend on it.

Two leading choices for this Cloudflare-first project are:

1. **Cloudflare Email Service** — simplest deployment and attractive pricing, native binding, but Email Sending is still Beta as of September 2026.
2. **Resend** — additional external service/API key, but mature transactional-email product with documented Workers integration and a free entry tier.

Because authentication email is critical and Cloudflare Email Sending is still Beta, the conservative initial recommendation is **Resend as the first production transport**, while keeping a Cloudflare Email Service adapter easy to add/switch when its maturity/risk profile is acceptable. This recommendation is intentionally isolated from the core architecture and can be changed without reopening auth contracts.

## Delivery semantics and observability

The application records only operational send outcome metadata needed for diagnosis. It does not create an email-marketing database or store message bodies by default.

Transport results should classify at least accepted/scheduled versus failed and expose a provider message id when available. Provider webhook/bounce/suppression ingestion is deferred until a concrete operational need exists; if introduced, it belongs to the email integration boundary rather than auth-domain logic.

## Security defaults to carry into implementation

- Require verified email before email/password login for this deployment, per ADR-0005.
- Avoid account enumeration responses/timing differences; preserve Better Auth's generic behavior.
- Verification/reset URLs and tokens are secrets and are redacted everywhere except the outbound message/test sink.
- Consider enabling session revocation after password reset in the implementation spec as a security default.
- Email-change policy should require verification of the new address; requiring confirmation at the old address can remain configurable.

## Revisit triggers

Introduce a durable queue when measured delivery failures, retry requirements, provider throttling, or asynchronous email volume justify the extra component. Re-evaluate Cloudflare Email Service as the default when it reaches a maturity level acceptable for production auth or the project explicitly accepts its Beta status.
