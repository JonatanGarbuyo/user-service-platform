# ADR-0003: Separate object storage from relational data

## Status

Accepted

## Context

User files such as avatars should not be stored in or served from the relational database.

## Decision

Store binary/user-uploaded objects in object storage. The relational database stores only object keys, URLs, metadata, ownership, and lifecycle state as needed.

For the initial Cloudflare deployment, R2 is the preferred object-storage candidate. The service should expose storage through a narrow adapter so S3-compatible alternatives can be introduced without changing feature contracts.

## Consequences

- Database load and growth remain independent from file traffic.
- Files can be served through object-storage/CDN paths.
- Storage lifecycle, validation, and authorization remain application concerns at the upload/delete boundary.
