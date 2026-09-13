// Sandbox smoke test (ticket #14, ADR-0008).
//
// Proves the deployed sandbox Worker serves the health and verified-email
// identity path without touching production accounts or production email
// recipients. Registration always uses an address inside the operator-provided
// sandbox domain (`SMOKE_SANDBOX_EMAIL_DOMAIN`), which must itself be covered
// by the sandbox `AUTH_MAIL_ALLOWLIST` so deliveries can never reach arbitrary
// recipients. The full verify -> sign-in transition needs a human to paste the
// token from the allowlisted mailbox (`SMOKE_VERIFICATION_TOKEN`); without it
// the smoke proves the deployed verification gate (register -> login rejected
// with `email-verification-required` -> resend accepted) and the integration
// suite remains the authority for the token transition.
//
// Redaction (ADR-0009): this script logs only HTTP method, path, status and
// stable problem codes. Passwords, tokens, cookies, action URLs, message
// bodies and raw email addresses never enter its output.

export interface SmokeConfig {
  readonly baseUrl: string;
  readonly emailDomain: string;
  readonly allowLocalhost: boolean;
  readonly password: string;
  readonly verificationToken: string | undefined;
}

type SmokeEnv = Pick<NodeJS.ProcessEnv, string> & {
  readonly SMOKE_SANDBOX_BASE_URL?: string;
  readonly SMOKE_SANDBOX_EMAIL_DOMAIN?: string;
  readonly SMOKE_ALLOW_LOCALHOST?: string;
  readonly SMOKE_PASSWORD?: string;
  readonly SMOKE_VERIFICATION_TOKEN?: string;
};

function readEnv(env: SmokeEnv, name: keyof SmokeEnv): string {
  return (env[name] ?? '').trim();
}

function isTruthy(value: string): boolean {
  return value.toLowerCase() === 'true' || value === '1';
}

export function buildSmokeEmail(domain: string, runId: string): string {
  return `smoke-${runId}@${domain.toLowerCase()}`;
}

function emailDomainOf(email: string): string | undefined {
  const separator = email.trim().toLowerCase().lastIndexOf('@');
  if (separator <= 0 || separator === email.trim().length - 1) {
    return undefined;
  }
  return email
    .trim()
    .toLowerCase()
    .slice(separator + 1);
}

// Fails closed when the registration address is outside the sandbox domain so
// a smoke run can never create identities for production recipients.
export function assertSandboxSmokeEmail(email: string, domain: string): void {
  const expected = domain.trim().toLowerCase();
  if (expected.length === 0) {
    throw new Error('Refusing sandbox smoke without an explicit sandbox email domain.');
  }
  if (emailDomainOf(email) !== expected) {
    throw new Error(
      `Refusing sandbox smoke for an address outside the sandbox domain (${expected}).`,
    );
  }
}

export function assertSafeSmokeTarget(
  baseUrl: string,
  options: { readonly allowLocalhost?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Refusing sandbox smoke without a valid SMOKE_SANDBOX_BASE_URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Refusing sandbox smoke for a non-HTTP(S) target.');
  }
  const host = url.hostname.toLowerCase();
  if ((host === 'localhost' || host === '127.0.0.1' || host === '::1') && !options.allowLocalhost) {
    throw new Error(
      'Refusing sandbox smoke against localhost without SMOKE_ALLOW_LOCALHOST=true; smoke evidence must come from the deployed sandbox.',
    );
  }
  return url;
}

export function resolveSmokeConfig(env: SmokeEnv = process.env): SmokeConfig {
  const baseUrl = readEnv(env, 'SMOKE_SANDBOX_BASE_URL');
  if (baseUrl.length === 0) {
    throw new Error('SMOKE_SANDBOX_BASE_URL is required (the deployed sandbox Worker origin).');
  }
  const emailDomain = readEnv(env, 'SMOKE_SANDBOX_EMAIL_DOMAIN');
  if (emailDomain.length === 0) {
    throw new Error(
      'SMOKE_SANDBOX_EMAIL_DOMAIN is required (a sandbox-allowlisted domain; never a production recipient domain).',
    );
  }
  const password = readEnv(env, 'SMOKE_PASSWORD');
  return {
    baseUrl,
    emailDomain: emailDomain.toLowerCase(),
    allowLocalhost: isTruthy(readEnv(env, 'SMOKE_ALLOW_LOCALHOST')),
    password: password.length > 0 ? password : `smoke-${crypto.randomUUID()}`,
    verificationToken: (() => {
      const token = readEnv(env, 'SMOKE_VERIFICATION_TOKEN');
      return token.length > 0 ? token : undefined;
    })(),
  };
}

function logStep(label: string, status: number, detail: string): void {
  console.log(JSON.stringify({ level: 'info', step: label, status, detail }));
}

interface ProblemShape {
  readonly code?: unknown;
  readonly status?: unknown;
}

function problemCode(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as ProblemShape).code;
    return typeof code === 'string' ? code : '<missing-code>';
  }
  return '<non-json>';
}

function booleanField(payload: unknown, field: string): boolean | undefined {
  if (typeof payload === 'object' && payload !== null) {
    const value = (payload as Record<string, unknown>)[field];
    return typeof value === 'boolean' ? value : undefined;
  }
  return undefined;
}

function stringField(payload: unknown, field: string): string | undefined {
  if (typeof payload === 'object' && payload !== null) {
    const value = (payload as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function cookieHeader(res: Response): string | undefined {
  const getter = res.headers.getSetCookie;
  if (typeof getter !== 'function') {
    return undefined;
  }
  const cookies = getter.call(res.headers);
  const pairs = cookies.map((cookie) => cookie.split(';')[0] ?? '').filter((part) => part !== '');
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

function fail(label: string, status: number, detail: string): never {
  console.log(JSON.stringify({ level: 'error', step: label, status, detail }));
  throw new Error(`Sandbox smoke failed at ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const config = resolveSmokeConfig();
  assertSafeSmokeTarget(config.baseUrl, { allowLocalhost: config.allowLocalhost });
  const base = config.baseUrl.replace(/\/+$/, '');
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const email = buildSmokeEmail(config.emailDomain, runId);
  assertSandboxSmokeEmail(email, config.emailDomain);

  const request = async (
    label: string,
    path: string,
    init: RequestInit = {},
    cookie?: string,
  ): Promise<{ readonly res: Response; readonly payload: unknown }> => {
    const headers = new Headers(init.headers);
    if (cookie !== undefined) {
      headers.set('cookie', cookie);
    }
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const payload = await readJson(res);
    logStep(label, res.status, problemCode(payload));
    return { res, payload };
  };

  // 1. Liveness without touching dependencies.
  const health = await request('health', '/v1/health');
  if (health.res.status !== 200 || stringField(health.payload, 'status') !== 'ok') {
    fail('health', health.res.status, 'expected 200 {status:"ok"}');
  }

  // 2. Anonymous callers get the standard unauthenticated Problem Details shape.
  const anonymous = await request('me-anonymous', '/v1/me');
  if (anonymous.res.status !== 401 || problemCode(anonymous.payload) !== 'unauthenticated') {
    fail('me-anonymous', anonymous.res.status, 'expected 401 unauthenticated');
  }

  // 3. Registration creates an unverified identity for the sandbox recipient.
  const register = await request('register', '/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Sandbox Smoke', email, password: config.password }),
  });
  if (register.res.status !== 201 || booleanField(register.payload, 'emailVerified') !== false) {
    fail('register', register.res.status, 'expected 201 with emailVerified:false');
  }

  // 4. The deployed verification gate rejects the session before verification.
  const gated = await request('login-unverified', '/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: config.password }),
  });
  if (gated.res.status !== 403 || problemCode(gated.payload) !== 'email-verification-required') {
    fail('login-unverified', gated.res.status, 'expected 403 email-verification-required');
  }

  // 5. A resend is accepted through the sandbox mail boundary.
  const resend = await request('request-verification', '/v1/auth/request-verification', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (resend.res.status !== 202 || stringField(resend.payload, 'status') !== 'ok') {
    fail('request-verification', resend.res.status, 'expected 202 {status:"ok"}');
  }

  // 6. Full verify -> sign-in only when the operator supplies the token from
  // the allowlisted mailbox; otherwise the gate evidence above stands.
  if (config.verificationToken !== undefined) {
    const verify = await request('verify-email', '/v1/auth/verify-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: config.verificationToken }),
    });
    if (verify.res.status !== 200 || booleanField(verify.payload, 'emailVerified') !== true) {
      fail('verify-email', verify.res.status, 'expected 200 with emailVerified:true');
    }
    const login = await request('login-verified', '/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: config.password }),
    });
    if (login.res.status !== 200) {
      fail('login-verified', login.res.status, 'expected 200 after verification');
    }
    const cookie = cookieHeader(login.res);
    if (cookie === undefined) {
      fail('login-verified', login.res.status, 'expected a session cookie after verification');
    }
    const me = await request('me-authenticated', '/v1/me', {}, cookie);
    if (me.res.status !== 200) {
      fail('me-authenticated', me.res.status, 'expected 200 for the verified session');
    }
  } else {
    console.log(
      JSON.stringify({
        level: 'info',
        step: 'verify-email',
        status: 0,
        detail: 'skipped-token-not-provided',
      }),
    );
  }

  console.log(JSON.stringify({ level: 'info', step: 'smoke', status: 200, detail: 'pass' }));
}

const invokedDirectly = process.argv[1]?.endsWith('smoke-sandbox.ts') === true;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.log(JSON.stringify({ level: 'error', step: 'smoke', status: 0, detail: message }));
    process.exitCode = 1;
  });
}
