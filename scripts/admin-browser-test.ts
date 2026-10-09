import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright-core';

// Administration SPA browser integration (ticket #124, ADR-0012).
//
// A real headless Chromium drives the real built administration SPA against
// the real isolated local Worker/D1: administrator sign-in -> identity
// landing -> reload -> sign-out, plus the verified regular-User denial path.
// No API response is mocked on these acceptance paths; every UI transition
// completes through the public HTTP boundary with the HttpOnly cookie
// session.
//
// Fixture setup (not acceptance behavior) prepares two verified local
// identities through public HTTP plus one documented local-D1 statement:
// verification delivery has no local observable surface by design (ADR-0010),
// so the script marks the fresh local rows verified directly instead of
// pasting tokens. The verify-email transition itself stays covered by the
// Workers integration suite (`admin-me.test.ts`, `identity.test.ts`).
//
// Local-only and bounded: fresh local D1 (`db:local:reset`), a dedicated
// `wrangler dev` port, finite readiness waits, and teardown that always
// closes the browser and terminates the Worker (success or failure).
//
// Redaction (ADR-0009): this script logs only stage names, HTTP method,
// path, status and stable problem codes. Names, email addresses, passwords,
// tokens, cookies, action URLs and message bodies never enter its output.

const execFileAsync = promisify(execFile);

function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

interface BrowserTestConfig {
  readonly port: number;
  readonly chromePath: string;
  readonly password: string;
}

function resolveConfig(env: NodeJS.ProcessEnv = process.env): BrowserTestConfig {
  const portRaw = (env.ADMIN_BROWSER_PORT ?? '8791').trim();
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('ADMIN_BROWSER_PORT must be a valid TCP port.');
  }
  const candidates = [env.CHROME_PATH ?? '', '/usr/bin/chromium', '/usr/bin/google-chrome'].map(
    (candidate) => candidate.trim(),
  );
  const chromePath = candidates.find((candidate) => candidate.length > 0 && existsSync(candidate));
  if (chromePath === undefined) {
    throw new Error(
      'No Chromium binary found (tried CHROME_PATH, /usr/bin/chromium, /usr/bin/google-chrome).',
    );
  }
  // Local-only test credential, never a real secret: the fresh local D1 is
  // disposable and holds no production data.
  const password = (env.ADMIN_BROWSER_PASSWORD ?? '').trim();
  return { port, chromePath, password: password.length > 0 ? password : 'correct-horse-41' };
}

function stage(message: string): void {
  console.log(`stage=${message}`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`browser assertion failed: ${message}`);
  }
}

async function runBounded(label: string, command: string, args: string[], timeoutMs: number): Promise<void> {
  try {
    await execFileAsync(command, args, {
      cwd: repoRoot(),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n').slice(0, 3).join(' ') : String(error);
    throw new Error(`${label} failed: ${detail}`);
  }
}

async function http(
  method: string,
  baseUrl: string,
  path: string,
  init: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; code: string | null; setCookies: string[]; text: string }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (init.cookie !== undefined && init.cookie.length > 0) {
    headers.cookie = init.cookie;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let code: string | null = null;
  const text = await response.text();
  try {
    const payload: unknown = JSON.parse(text) as unknown;
    if (typeof payload === 'object' && payload !== null) {
      const value = (payload as Record<string, unknown>).code;
      code = typeof value === 'string' ? value : null;
    }
  } catch {
    code = null;
  }
  const setCookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  console.log(`http method=${method} path=${path} status=${String(response.status)} code=${code ?? '-'}`);
  return { status: response.status, code, setCookies, text };
}

function cookiePairs(setCookies: string[]): { name: string; value: string }[] {
  const pairs: { name: string; value: string }[] = [];
  for (const header of setCookies) {
    const pair = header.split(';')[0]?.trim() ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) {
      pairs.push({ name: pair.slice(0, separator), value: pair.slice(separator + 1) });
    }
  }
  return pairs;
}

function cookieHeader(setCookies: string[]): string {
  return cookiePairs(setCookies)
    .map((pair) => `${pair.name}=${pair.value}`)
    .join('; ');
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // The Worker is still booting; keep polling within the bound.
    }
    if (Date.now() > deadline) {
      throw new Error('local Worker did not become ready within 60s.');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function stopWorker(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!done) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process already exited; teardown must not fail.
        }
      }
      setTimeout(finish, 2000);
    }, 10_000);
  });
}

async function waitForHttpStatus(
  method: string,
  baseUrl: string,
  path: string,
  cookie: string,
  expected: number,
): Promise<void> {
  // Session revocation settles asynchronously past UI navigation: poll the
  // observable contract briefly instead of asserting a single racy request.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const response = await http(method, baseUrl, path, { cookie });
    if (response.status === expected) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `browser assertion failed: ${method} ${path} never reached ${String(expected)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const root = repoRoot();
  const baseUrl = `http://localhost:${String(config.port)}`;
  const runId = Date.now().toString(36).replace(/[^a-z0-9]/g, '');

  stage('reset-local-d1');
  await runBounded('db:local:reset', 'npm', ['run', 'db:local:reset'], 120_000);

  if (!existsSync(resolve(root, 'admin', 'dist', 'index.html'))) {
    stage('build-admin');
    await runBounded('build:admin', 'npm', ['run', 'build:admin'], 300_000);
  }

  stage('start-worker');
  const worker = spawn('npx', ['wrangler', 'dev', '--port', String(config.port)], {
    cwd: root,
    stdio: 'pipe',
  });
  let browser: Browser | null = null;
  try {
    await waitForHealth(baseUrl);
    stage('worker-ready');

    // Fixture identities through public HTTP on the fresh local database.
    stage('fixture-admin-bootstrap');
    const bootstrap = await http('POST', baseUrl, '/v1/auth/admin/bootstrap', {
      body: { name: 'Browser Admin', email: `browser-admin-${runId}@example.com`, password: config.password },
    });
    assert(bootstrap.status === 201, 'admin bootstrap creates the fixture administrator');

    stage('fixture-regular-register');
    const register = await http('POST', baseUrl, '/v1/auth/register', {
      body: {
        name: 'Browser User',
        email: `browser-user-${runId}@example.com`,
        password: config.password,
      },
    });
    assert(register.status === 201, 'registration creates the fixture regular User');

    // Verification delivery has no local observable surface (ADR-0010), so
    // the fresh local rows are marked verified directly. The verify-email
    // transition itself is covered by the Workers integration suite.
    stage('fixture-mark-verified');
    await runBounded(
      'mark-verified',
      'npx',
      ['wrangler', 'd1', 'execute', 'DB', '--local', '--command', 'UPDATE "user" SET email_verified = 1'],
      120_000,
    );

    // Real assets load as HTML with the SPA mount point; unknown API routes
    // stay JSON Problem Details through the real Worker.
    stage('spa-and-api-routing');
    const spa = await http('GET', baseUrl, '/admin/');
    assert(spa.status === 200, 'SPA entry loads');
    assert(spa.text.includes('<div id="root"'), 'SPA entry carries the mount point');
    const unknown = await http('GET', baseUrl, '/v1/does-not-exist');
    assert(unknown.status === 404 && unknown.code === 'not-found', 'unknown API stays JSON');

    browser = await chromium.launch({
      executablePath: config.chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    // Administrator sign-in -> landing -> reload -> sign-out.
    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await adminContext.newPage();
      try {
        await page.goto(`${baseUrl}/admin/`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'Administración' }).waitFor({ timeout: 15_000 });

        const bad = await page
          .getByRole('button', { name: 'Iniciar sesión' })
          .waitFor({ timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        assert(bad, 'anonymous navigation presents sign-in');

        await page.getByLabel('Correo electrónico').fill(`browser-admin-${runId}@example.com`);
        await page.getByLabel('Contraseña').fill('wrong-password-99');
        await page.getByRole('button', { name: 'Iniciar sesión' }).click();
        await page.getByText('Credenciales inválidas').waitFor({ timeout: 15_000 });
        stage('admin-wrong-password-denied');

        await page.getByLabel('Contraseña').fill(config.password);
        await page.getByRole('button', { name: 'Iniciar sesión' }).click();
        await page.getByText('Sesión de administración').waitFor({ timeout: 15_000 });
        await page.getByText(`browser-admin-${runId}@example.com`).waitFor({ timeout: 15_000 });
        stage('admin-landing');

        await page.reload({ waitUntil: 'networkidle' });
        await page.getByText('Sesión de administración').waitFor({ timeout: 15_000 });
        stage('admin-reload-restores-authorization');

        const cookies = await adminContext.cookies();
        const sessionCookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
        assert(sessionCookie.length > 0, 'browser holds a session cookie');
        const me = await http('GET', baseUrl, '/v1/me', { cookie: sessionCookie });
        assert(me.status === 200, 'browser session resolves through the API');

        await page.getByRole('button', { name: 'Cerrar sesión' }).click();
        await page.getByRole('button', { name: 'Iniciar sesión' }).waitFor({ timeout: 15_000 });
        stage('admin-sign-out');

        await waitForHttpStatus('GET', baseUrl, '/v1/me', sessionCookie, 401);
        stage('sign-out-revokes-session');
        const afterAdmin = await http('GET', baseUrl, '/v1/admin/me', { cookie: sessionCookie });
        assert(
          afterAdmin.status === 401 && afterAdmin.code === 'unauthenticated',
          'revoked session rejected on the admin contract',
        );

        await page.goto(`${baseUrl}/admin/`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Iniciar sesión' }).waitFor({ timeout: 15_000 });
        stage('admin-protected-after-sign-out');
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await adminContext.close().catch(() => undefined);
    }

    // Verified regular User: explicit denial without administrative data,
    // including direct navigation. The panel never signs this session out:
    // authorization stays a server verdict, not a destroyed session.
    const regularLogin = await http('POST', baseUrl, '/v1/auth/login', {
      body: { email: `browser-user-${runId}@example.com`, password: config.password },
    });
    assert(regularLogin.status === 200, 'fixture regular User signs in through the API');
    const regularContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await regularContext.addCookies(
        cookiePairs(regularLogin.setCookies).map((pair) => ({
          name: pair.name,
          value: pair.value,
          domain: 'localhost',
          path: '/',
        })),
      );
      const page = await regularContext.newPage();
      try {
        await page.goto(`${baseUrl}/admin/`, { waitUntil: 'networkidle' });
        await page.getByText('Acceso denegado').first().waitFor({ timeout: 15_000 });
        const adminIdentity = await page
          .getByText(`browser-admin-${runId}@example.com`)
          .count();
        assert(adminIdentity === 0, 'denial exposes no administrative data');
        stage('regular-access-denied');

        // The denial preserves the session: the public contract still
        // resolves while the admin contract keeps refusing.
        const regularCookie = cookieHeader(regularLogin.setCookies);
        const stillMe = await http('GET', baseUrl, '/v1/me', { cookie: regularCookie });
        assert(stillMe.status === 200, 'denial preserves the regular session');
        const stillDenied = await http('GET', baseUrl, '/v1/admin/me', { cookie: regularCookie });
        assert(
          stillDenied.status === 403 && stillDenied.code === 'forbidden',
          'admin contract keeps refusing the regular session',
        );
        stage('regular-denial-keeps-session');

        // The denial state stays directly linkable.
        await page.goto(`${baseUrl}/admin/denegado`, { waitUntil: 'networkidle' });
        await page.getByText('Acceso denegado').first().waitFor({ timeout: 15_000 });
        await page
          .getByRole('button', { name: 'Volver al inicio de sesión' })
          .waitFor({ timeout: 15_000 });
        stage('denial-deeplink');
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await regularContext.close().catch(() => undefined);
    }

    // Sign-in deep link survives refresh on a clean context.
    const freshContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await freshContext.newPage();
      try {
        await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Iniciar sesión' }).waitFor({ timeout: 15_000 });
        await page.reload({ waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Iniciar sesión' }).waitFor({ timeout: 15_000 });
        stage('signin-deeplink-refresh');
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await freshContext.close().catch(() => undefined);
    }

    stage('browser-acceptance-complete');
  } finally {
    if (browser !== null) {
      await browser.close().catch(() => undefined);
    }
    await stopWorker(worker);
  }
}

const invokedDirectly = process.argv[1]?.endsWith('admin-browser-test.ts') === true;
if (invokedDirectly) {
  main().then(
    () => {
      process.exitCode = 0;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'unknown browser test failure');
      process.exitCode = 1;
    },
  );
}
