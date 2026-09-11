import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';
import { resolveAuthSecret } from './secret.js';

// Seam under test (ticket #10, ADR-0011): the public HTTP boundary of the built
// Worker, executed inside the Cloudflare Workers runtime with the isolated test
// D1 database. These tests prove registration, the pre-verification login
// block, verification, and the changed post-verification login eligibility —
// never Better Auth or D1 internals.
const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    ...overrides,
  };
}

const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });

async function post(path: string, body: unknown, overrides: Partial<Env> = {}): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    testEnv(overrides),
  );
}

async function userCount(binding: Env['DB']): Promise<number> {
  const row = await binding.prepare('SELECT COUNT(*) AS total FROM "user"').first<{
    total: number;
  }>();
  return row?.total ?? 0;
}

function tokenFromLastMessage(): string {
  const messages = mailer.sent;
  expect(messages.length).toBeGreaterThan(0);
  const last = messages[messages.length - 1];
  if (last === undefined) {
    throw new Error('Expected a captured verification message.');
  }
  const token = new URL(last.url).searchParams.get('token');
  if (token === null) {
    throw new Error('Expected a token in the captured verification action URL.');
  }
  return token;
}

beforeAll(async () => {
  await applyD1Migrations(workerEnv.DB, testMigrations);
});

beforeEach(async () => {
  const db = workerEnv.DB;
  await db.batch([
    db.prepare('DELETE FROM "session"'),
    db.prepare('DELETE FROM "account"'),
    db.prepare('DELETE FROM "verification"'),
    db.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('POST /v1/auth/register', () => {
  it('registers a new user and schedules a verification message', async () => {
    const res = await post('/v1/auth/register', {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct-horse-41',
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as { id: string; email: string; emailVerified: boolean };
    expect(typeof body.id).toBe('string');
    expect(body.email).toBe('ada@example.com');
    expect(body.emailVerified).toBe(false);

    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0];
    expect(message?.to).toBe('ada@example.com');
    expect(message?.url).toContain('token=');
    // The captured action must not carry credential material with it.
    expect(JSON.stringify(message)).not.toContain('correct-horse-41');

    expect(await userCount(workerEnv.DB)).toBe(1);
  });

  it('rejects registration with a stable error when the policy disables it', async () => {
    const res = await post(
      '/v1/auth/register',
      { name: 'Grace Hopper', email: 'grace@example.com', password: 'correct-horse-41' },
      { AUTH_REGISTRATION_ENABLED: 'false' },
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const body = (await res.json()) as { code: string; status: number };
    expect(body.code).toBe('registration-disabled');
    expect(body.status).toBe(403);

    expect(mailer.sent).toHaveLength(0);
    expect(await userCount(workerEnv.DB)).toBe(0);
  });

  it('rejects invalid registration input through the public contract', async () => {
    const res = await post('/v1/auth/register', {
      name: 'Bad Input',
      email: 'not-an-email',
      password: 'short',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('bad-request');
    expect(await userCount(workerEnv.DB)).toBe(0);
  });

  it('answers duplicate registration generically without duplicating identities', async () => {
    const payload = {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct-horse-41',
    };
    const first = await post('/v1/auth/register', payload);
    const second = await post('/v1/auth/register', payload);

    expect(first.status).toBe(201);
    // Same observable shape as a fresh registration so the response cannot
    // be used to probe for existing accounts.
    expect(second.status).toBe(201);
    expect(await userCount(workerEnv.DB)).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('rejects auth operations with a stable error when email/password is disabled', async () => {
    const disabled = { AUTH_EMAIL_PASSWORD_ENABLED: 'false' };

    const registerRes = await post(
      '/v1/auth/register',
      { name: 'No Auth', email: 'noauth@example.com', password: 'correct-horse-41' },
      disabled,
    );
    const loginRes = await post(
      '/v1/auth/login',
      { email: 'noauth@example.com', password: 'correct-horse-41' },
      disabled,
    );

    for (const res of [registerRes, loginRes]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'email-password-disabled', status: 403 });
    }
    expect(await userCount(workerEnv.DB)).toBe(0);
  });
});

describe('verified-email login gate', () => {
  it('blocks email/password login before verification with a machine-readable error', async () => {
    await post('/v1/auth/register', {
      name: 'Alan Turing',
      email: 'alan@example.com',
      password: 'correct-horse-41',
    });

    const res = await post('/v1/auth/login', {
      email: 'alan@example.com',
      password: 'correct-horse-41',
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const body = (await res.json()) as { code: string; status: number };
    expect(body).toMatchObject({ code: 'email-verification-required', status: 403 });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('allows login after a valid verification action', async () => {
    await post('/v1/auth/register', {
      name: 'Alan Turing',
      email: 'alan@example.com',
      password: 'correct-horse-41',
    });

    const verifyRes = await post('/v1/auth/verify-email', { token: tokenFromLastMessage() });
    expect(verifyRes.status).toBe(200);
    const verified = (await verifyRes.json()) as { emailVerified: boolean };
    expect(verified.emailVerified).toBe(true);

    const loginRes = await post('/v1/auth/login', {
      email: 'alan@example.com',
      password: 'correct-horse-41',
    });
    expect(loginRes.status).toBe(200);
    const sessionCookie = loginRes.headers.get('set-cookie');
    expect(sessionCookie).toContain('better-auth.session_token');

    const loginBody = JSON.stringify(await loginRes.json());
    expect(loginBody).toContain('alan@example.com');
    // Session material travels in the cookie, never in the JSON body.
    expect(loginBody).not.toContain('better-auth.session_token');
  });

  it('fails safely on invalid verification tokens without leaking material', async () => {
    const res = await post('/v1/auth/verify-email', { token: 'not-a-real-token' });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const raw = await res.text();
    expect(raw).not.toContain('not-a-real-token');
    expect(JSON.parse(raw)).toMatchObject({ code: 'verification-invalid', status: 400 });
  });

  it('fails safely on expired verification tokens', async () => {
    await post('/v1/auth/register', {
      name: 'Expired Token',
      email: 'expired@example.com',
      password: 'correct-horse-41',
    });

    const res = await post('/v1/auth/verify-email', {
      token: await expiredTokenFor('expired@example.com'),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('verification-invalid');

    // The account is still unverified, so login stays blocked.
    const loginRes = await post('/v1/auth/login', {
      email: 'expired@example.com',
      password: 'correct-horse-41',
    });
    expect(loginRes.status).toBe(403);
  });

  it('rejects wrong credentials without revealing account state', async () => {
    await post('/v1/auth/register', {
      name: 'Known User',
      email: 'known@example.com',
      password: 'correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: tokenFromLastMessage() });

    const wrongPassword = await post('/v1/auth/login', {
      email: 'known@example.com',
      password: 'wrong-password-99',
    });
    const unknownEmail = await post('/v1/auth/login', {
      email: 'nobody@example.com',
      password: 'wrong-password-99',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Both failures share the same stable shape so neither response reveals
    // whether the account exists.
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
  });
});

describe('POST /v1/auth/request-verification', () => {
  it('resends verification without creating duplicate identities', async () => {
    await post('/v1/auth/register', {
      name: 'Resend Me',
      email: 'resend@example.com',
      password: 'correct-horse-41',
    });
    expect(mailer.sent).toHaveLength(1);

    const first = await post('/v1/auth/request-verification', { email: 'resend@example.com' });
    const second = await post('/v1/auth/request-verification', { email: 'resend@example.com' });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await userCount(workerEnv.DB)).toBe(1);
    expect(mailer.sent.length).toBeGreaterThanOrEqual(3);
  });

  it('answers generically for unknown emails to resist enumeration', async () => {
    const res = await post('/v1/auth/request-verification', { email: 'ghost@example.com' });

    expect(res.status).toBe(202);
    expect(mailer.sent).toHaveLength(0);
    expect(await userCount(workerEnv.DB)).toBe(0);
  });
});

describe('identity observability redaction', () => {
  it('never logs passwords, tokens, action URLs or message bodies', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(' '));
    });

    try {
      await post('/v1/auth/register', {
        name: 'Log Check',
        email: 'logs@example.com',
        password: 'correct-horse-41',
      });
      const token = tokenFromLastMessage();
      await post('/v1/auth/login', { email: 'logs@example.com', password: 'correct-horse-41' });
      await post('/v1/auth/verify-email', { token });
      await post('/v1/auth/login', { email: 'logs@example.com', password: 'correct-horse-41' });
      await post('/v1/auth/verify-email', { token: 'not-a-real-token' });
    } finally {
      spy.mockRestore();
    }

    const transcript = seen.join('\n');
    expect(transcript).not.toContain('correct-horse-41');
    expect(transcript).not.toContain(tokenFromLastMessage());
    // No action URLs, tokens or query strings: request logs carry the matched
    // route pattern (`/v1/auth/verify-email`) but never `?token=...`.
    expect(transcript).not.toContain('token=');
    expect(transcript).not.toContain('?token=');
  });
});

// Builds a genuinely expired HS256 email-verification token with the same
// contract Better Auth verifies (payload email + exp), signed with the test
// environment secret. Proves expired actions fail safely end to end.
async function expiredTokenFor(email: string): Promise<string> {
  const secret = new TextEncoder().encode(resolveAuthSecret(testEnv()));
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const past = Math.floor(Date.now() / 1000) - 7200;
  const payload = encode({ email: email.toLowerCase(), iat: past, exp: past + 60 });
  const signature = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const signaturePart = Buffer.from(signature)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${header}.${payload}.${signaturePart}`;
}
