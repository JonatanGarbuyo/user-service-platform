# Research: Mercado Pago subscription provider boundary

Researched 2026-10-14 for Wayfinder [#146](https://github.com/JonatanGarbuyo/user-service-platform/issues/146), decision [#148](https://github.com/JonatanGarbuyo/user-service-platform/issues/148). Documentation research only: no credentials, provider calls, payments or deployment changes.

## Scope and conclusion

Use this repository for the backend. Monthly and annual subscriptions are confirmed requirements. The operator subsequently selected Mercado Pago Argentina in ARS and cancellation that stops renewal while preserving the paid period; prices remain undecided. The consumer owns Astro integration, login UI and paywall behavior. The service owns identity, commercial subscription state and a replaceable payment integration.

Mercado Pago documents recurring subscriptions and hosted checkout, matching the operator's selected first-adapter direction. It does **not** remove the need for application-owned payment reconciliation and paid-period policy. Two integration risks need explicit validation: subscription webhook configuration/signatures are documented inconsistently, and subscription mutation endpoints lack an explicit idempotency guarantee in the inspected references. This report proposes technical constraints; provider/account behavior still requires validation and the architecture remains subject to specification.

## Documented capabilities

| Concern              | Verified documentation                                                                                                                                                                                                                                                                      | Implication or remaining uncertainty                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monthly and annual   | The overview explicitly supports monthly and annual recurrence; the associated-plan guide uses monthly and annual offerings as an example. [S1, S2]                                                                                                                                         | An annual charge is distinct from twelve monthly installments. The proposed mapping is 1 or 12 calendar months; validate the exact annual request and calendar boundaries with the selected country/account before acceptance. Do not confuse `repetitions: 12` with annual frequency.                                                |
| Plans                | `POST /preapproval_plan` defines a reusable provider template; subscriptions can reference its ID. Plan changes can synchronize attributes such as reason/amount. [S2, S3]                                                                                                                  | Keep our offer/price identity separate from provider plan identity. Choose associated plans versus per-user recurrence explicitly; provider plan changes need a deliberate existing-subscriber price policy.                                                                                                                          |
| Hosted start         | A pending subscription is created without a payment method through `POST /preapproval`; the buyer can follow a payment link. Creation returns a subscription ID and `init_point`; `back_url` is a return destination. [S4, S5]                                                              | Prefer researching this redirect flow for the initial consumer contract. The server chooses offer, amount, currency and allowed return destination; a browser return is not evidence of paid access.                                                                                                                                  |
| Authorization        | An `authorized` subscription schedules recurring payments. The authorized-flow guide describes a small validation charge followed by refund, and delayed first-installment processing. It also says a `processed` installment can be associated with a rejected payment after retries. [S6] | Subscription authorization, card verification, installment processing and successful payment are separate facts. Never grant a paid period solely from `authorized`, a return URL, or `processed`. The guide's timing is not a local/CI timing guarantee.                                                                             |
| Reconciliation reads | `GET /preapproval/{id}` exposes recurrence, status, modification/version information, next payment and summary fields. `GET /authorized_payments/{id}` links an installment to its subscription and payment, with debit date, retry information and payment status. [S7, S8]                | Reconcile individual provider resources; `next_payment_date` alone is not a guaranteed paid-through date. Determine our period and access policy separately. The invoice example itself mixes scheduled/pending fields with an approved nested payment; examples are not a canonical state machine.                                   |
| Management           | `PUT /preapproval/{id}` supports updates; the management guide documents pause, cancellation, paused-subscription reactivation, amount and payment-method changes. [S9, S10]                                                                                                                | Cancellation is a provider operation, not our paid-period/refund policy. The guide spells cancellation `canceled`; verify accepted wire status against the selected API/account rather than normalizing spelling by guesswork. Do not assume canceled subscriptions can be reactivated or that cancellation refunds previous charges. |

## Notifications and delivery

The Webhooks guide lists `subscription_preapproval`, `subscription_preapproval_plan`, `subscription_authorized_payment`, and `payment`. It describes HMAC validation using `x-signature`, `x-request-id`, query `data.id`, and an application secret. It requests HTTP 200/201 within 22 seconds; otherwise delivery retries initially every 15 minutes, extending after the third attempt. It recommends resource reads after receipt. [S11]

**Documentation conflict:** the same guide says configuration through Tus integraciones is unavailable for Suscripciones and directs integrators to creation-time configuration, while its signing instructions obtain the secret through Tus integraciones. Signed delivery for our selected flow/account is **unverified**. Confirm configuration, payload matching and secret availability in a provider test or with support. [S11]

**Design inference:** treat notifications as hints to reconcile authenticated, account-scoped resources. Persist receipt/work durably before acknowledgment, or return a retryable failure; do not acknowledge and lose in-memory work. Make processing repeatable, deduplicate payment/period effects, and serialize or version concurrent reconciliation. No ordering or exactly-once guarantee was found. Delayed notifications must not overwrite newer observations; signatures do not prove resource ownership or payment success.

## Idempotency: verify each operation

| Operation                                | Inspected documented guarantee                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /preapproval`                      | No `X-Idempotency-Key` or replay guarantee found in its rendered reference. [S5]                                                                        |
| `POST /preapproval_plan`                 | No explicit replay guarantee found. [S3]                                                                                                                |
| `PUT /preapproval/{id}` including cancel | No explicit idempotency-key guarantee found. [S9]                                                                                                       |
| `PUT /preapproval_plan/{id}`             | No explicit idempotency-key guarantee found. [S12]                                                                                                      |
| `POST /v1/payments`                      | Reference explicitly requires `X-Idempotency-Key` for safe repetition. This is a different operation; it does not establish preapproval behavior. [S13] |
| Resource `GET`s                          | Observation only; they do not authorize repeating an ambiguous mutation. [S7, S8]                                                                       |

Absence is **unknown support**, not proof of unsupported headers. SDK-generated headers do not establish server guarantees. Proposed behavior: durable request identity, one logical checkout, persisted references and an unknown/reconciliation outcome after ambiguous mutation. `external_reference` documents correlation, not uniqueness. Prove lost-create-response recovery; avoid blind create retries. [S5]

## Local/CI and provider acceptance seams

Official test-account guidance requires distinct seller/buyer roles in the same country; test-country selection is immutable. It notes test-user login lacks some developer-panel sections, including test credentials. The subscription purchase guide uses test-user credentials and test cards. The authorized guide separately shows a test token and stage header; these pages do not settle the credential procedure for our chosen hosted flow. [S6, S14, S15]

Proposed tests, subject to the approved specification:

- Offline service HTTP/D1 tests with a fake billing adapter and fixed clock: identity binding, monthly/annual offer selection, checkout retry, authorization without payment, paid renewal, expiry, cancellation and no fabricated paid-period extension on provider failure.
- Adapter HTTP fixtures based on validated official resource shapes: signature rejection/mismatch, resource ownership, duplicate and reversed delivery, concurrent reconciliation, rejected/refunded payments, ambiguous creates and currency/amount mismatch. Fake-provider success proves our behavior, not Mercado Pago compatibility.
- A separate operator-driven provider test, with isolated seller/buyer accounts, configured callback endpoint and test cards: actual redirect/return, verified resource reads, signature/setup confirmation, first charge, duplicate delivery and cancellation. Confirm whether renewal/time simulation is available; no supported time-travel mechanism was found. CI must not wait months or use production credentials. The user can proxy account steps and provide redacted results; hosted agents are unnecessary for offline development.

## Replaceability and decisions still needed

**Proposed boundary:** application-owned subscription/offer IDs, recurrence and money values, checkout result, reconciliation observations and cancellation intent. Keep MP subscription/plan/payment/payer IDs, raw statuses, webhook payloads and API types inside adapter-owned records, keyed by provider, account and environment. Public consumer contracts describe our subscription/payment facts and checkout URL; they do not require `preapproval_id`. This follows this repo's glossary and ADR-0002/0004/0007 separation rules; it does not justify a generic payment framework before concrete needs are proven.

**Portability limit:** the inspected sources describe provider-owned subscription, application, seller, payer and card identifiers, not cross-provider authorization export. No portable recurring mandate or migration mechanism was verified. Replacing the adapter for new purchases must not imply moving existing charges. Plan for existing subscriptions to retain their original adapter while a separately approved migration may require fresh customer authorization; prevent double billing. [S5, S7]

Country/currency, first provider and cancellation through the already-paid period are now operator decisions. Still resolve seller account and checkout mode; activation/paid-period calculation, calendar/timezone, failed-renewal grace, refunds/chargebacks; plan change/price version policy; and mutation recovery/signature test acceptance. Prices can remain unset until commercial launch. This research does not decide these business policies.

## Primary sources

All URLs below were inspected on 2026-10-14. The operator selected Argentina/ARS; these sources do not validate a particular seller account or deployment. API examples can be stale or inconsistent.

- [S1: Subscriptions overview](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/overview)
- [S2: Subscriptions with an associated plan](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-configuration/subscription-associated-plan)
- [S3: Create subscription plan](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/create-preapproval-plan/post)
- [S4: Subscriptions with pending payment](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments)
- [S5: Create subscription](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/create-preapproval/post)
- [S6: Subscriptions with authorized payment](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/authorized-payments)
- [S7: Get subscription](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-preapproval/get)
- [S8: Get invoice data](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-authorized-payment/get)
- [S9: Update subscription](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/update-preapproval/put)
- [S10: Subscription management](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/subscription-management)
- [S11: Subscription Webhooks](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/additional-content/your-integrations/notifications/webhooks)
- [S12: Update subscription plan](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/update-preapproval-plan/put)
- [S13: Create payment](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/create-payment/post)
- [S14: Test accounts](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/additional-content/your-integrations/test/accounts)
- [S15: Test purchase](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-test/payment-approval)
