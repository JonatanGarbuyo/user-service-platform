# Domain context

## Purpose

A reusable user-service foundation for content-oriented web products. The first deployment is single-client, not multi-tenant SaaS.

## Core concepts

### User
A registered end user of the consuming site. Editorial CMS operators are not Users in this domain.

### Identity
Authentication identity, credentials, linked providers, account recovery, and session lifecycle.

### Profile
User-facing account data such as display name, avatar reference, and preferences.

### Subscription
The user's commercial access state. Subscription is not an editorial role. It may contain plan, status, dates, and external billing references.

### Follow
A relationship in which a User follows a target entity identified by an external canonical id and target type. Targets may include teams, topics, competitions, players, authors, or eventually users.

### Bookmark
A User's saved reference to content for later access.

### Audience
A queryable/segmentable set of Users used for operational or commercial export. The service supports segmentation/export but does not deliver newsletters.

### Marketing consent
The User's explicit communication preference and its relevant metadata, such as timestamp/source.

### Community
Optional future functionality containing comments, replies, votes, reports, and moderation. Community is not part of the initial core.

### Analytics
Traffic/product analytics is a separate service or third-party platform. This service may emit events for analytics consumers but does not own analytics storage/reporting.

## Product boundaries

### In scope initially

- identity and sessions
- profile
- subscription state
- follows
- bookmarks
- preferences/consent
- audience segmentation/export
- object-storage-backed user files such as avatars
- integration/domain events

### Candidate later modules

- reading history
- saved statistical filters/comparisons
- notification preferences
- community/comments/replies/votes
- follow users
- referral/promotion metadata
- internal operator/admin authentication and admin UI

### Out of scope

- editorial CMS roles and publishing permissions
- newsletter delivery
- web/product analytics platform
- hard protection of premium content; consuming products may use a client-side soft paywall
- internal operator/admin authentication and admin UI in the initial version

## Architectural vocabulary

### Feature slice
A vertical unit that owns an externally observable capability across contract, domain behaviour, persistence and tests.

### Contract
A runtime-validatable public interface. HTTP contracts are the source for generated OpenAPI and clients.

### Adapter
A narrow integration boundary for infrastructure whose implementation may change, such as object storage or an external provider.
