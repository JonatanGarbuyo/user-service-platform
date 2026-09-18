// Deterministic deployment naming (ticket #78, ADR-0008).
//
// A deployment target owns a company slug, a site slug, a service slug and a
// canonical environment. The canonical deployment key is:
//
//   <company>-<site>-<service>-<environment>
//
// The site is part of the isolation boundary: one company may own multiple
// sites, each with a fully separate login/session/user store. Physical
// Cloudflare resource names derive from that key with explicit semantic
// suffixes (`-db`, `-session`, `-files`); application binding names stay
// short and stable (`DB`, future `SESSION`, future `FILES`).
//
// Canonical deployable environments are `sandbox` and `production` only.
// `staging` is never offered: historical staging references mean `sandbox`,
// and `local`/`test` are never deployment targets.
export type DeployableEnvironment = 'sandbox' | 'production';

export interface DeploymentIdentity {
  readonly company: string;
  readonly site: string;
  readonly service: string;
  readonly environment: DeployableEnvironment;
}

// workers.dev DNS-label limit: the fully materialized Worker name must fit.
// Names are validated before any remote mutation and rejected — never
// silently truncated — when they exceed the limit.
export const MAX_WORKER_NAME_LENGTH = 63;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type ResourceSuffix = 'db' | 'session' | 'files';

const RESOURCE_SUFFIXES: ReadonlySet<string> = new Set(['db', 'session', 'files']);

function assertSlug(kind: 'company' | 'site' | 'service', value: string): void {
  if (value.length === 0 || !SLUG_PATTERN.test(value)) {
    throw new Error(
      `Invalid deployment ${kind} slug: expected lowercase alphanumeric words joined with "-".`,
    );
  }
}

// Parses a deployment environment (`parseDontValidate`: returns the refined
// value). `staging` is refused explicitly so automation typos fail with
// guidance instead of silently targeting sandbox.
export function parseDeployEnvironment(value: unknown): DeployableEnvironment {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'sandbox' || normalized === 'production') {
    return normalized;
  }
  if (normalized === 'staging') {
    throw new Error(
      'Invalid deployment environment "staging": canonical environments are "sandbox" and "production" only (historical staging references mean "sandbox").',
    );
  }
  throw new Error('Invalid deployment environment: expected "sandbox" or "production".');
}

// The canonical deployment key; also the Worker name.
export function deploymentKey(identity: DeploymentIdentity): string {
  assertSlug('company', identity.company);
  assertSlug('site', identity.site);
  assertSlug('service', identity.service);
  const key = `${identity.company}-${identity.site}-${identity.service}-${identity.environment}`;
  assertWorkerName(key);
  return key;
}

export function workerName(identity: DeploymentIdentity): string {
  return deploymentKey(identity);
}

export function databaseName(identity: DeploymentIdentity): string {
  return `${deploymentKey(identity)}-db`;
}

// Physical resource names append one explicit suffix owned by the resource
// kind. New resource types must register a suffix here; arbitrary positional
// segments are rejected.
export function resourceName(key: string, suffix: string): string {
  if (!RESOURCE_SUFFIXES.has(suffix)) {
    throw new Error(
      `Invalid resource suffix "${suffix}": expected one of "db", "session" or "files".`,
    );
  }
  return `${key}-${suffix}`;
}

export function assertWorkerName(name: string): void {
  if (name.length > MAX_WORKER_NAME_LENGTH) {
    throw new Error(
      `Invalid Worker name: ${String(name.length)} characters exceeds the ${String(MAX_WORKER_NAME_LENGTH)}-character workers.dev DNS-label limit; shorten the company/site/service slugs instead of truncating.`,
    );
  }
  if (!WORKER_NAME_PATTERN.test(name)) {
    throw new Error(
      'Invalid Worker name: expected a lowercase DNS label (alphanumerics and "-", starting and ending alphanumeric).',
    );
  }
}
