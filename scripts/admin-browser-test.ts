import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Administration browser assertion: ${message}`);
}

async function command(label: string, args: string[]): Promise<void> {
  try {
    await exec(process.execPath, args, { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (cause) {
    // Command output can contain fixture data: expose only a stable stage.
    throw new Error(`Administration browser setup failed: ${label}`, { cause });
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert(address !== null && typeof address !== 'string', 'TCP port allocated');
  const port = address.port;
  await new Promise<void>((done, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else done();
    }),
  );
  return port;
}

async function stopWorker(child: ChildProcess): Promise<void> {
  const running = () => {
    if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!running()) return;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      /* Already exited. */
    }
  };
  kill('SIGTERM');
  for (let i = 0; i < 20 && running(); i++) await pause(100);
  if (running()) kill('SIGKILL');
}

async function visible(page: Page, name: string): Promise<void> {
  await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 15_000 });
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await visible(page, 'Administración');
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
}

// Real browser + real built Worker/D1. Fixture-only SQL is restricted to a
// fresh mkdtemp database; ordinary local state and remote resources are untouched.
// No API response mocks, copied account tokens, or default-database reset.
export async function runAdminBrowserTest(): Promise<void> {
  assert(existsSync(join(root, 'admin/dist/index.html')), 'current frontend build exists');
  const state = await mkdtemp(join(tmpdir(), 'user-service-admin-'));
  let worker: ChildProcess | undefined;
  let browser: Browser | undefined;
  let diagnosticPage: Page | undefined;
  let phase = 'setup';
  try {
    const config = join(state, 'wrangler.jsonc');
    const persist = join(state, 'd1');
    const envFile = join(state, '.env');
    await writeFile(envFile, '');
    await writeFile(join(state, '.dev.vars'), '');
    const original = await readFile(join(root, 'wrangler.jsonc'), 'utf8');
    // Preserve all routing/binding configuration; relocate only file paths so
    // local-secret discovery and storage also live in the disposable directory.
    await writeFile(
      config,
      original
        .replace('"main": "src/index.ts"', `"main": ${JSON.stringify(join(root, 'src/index.ts'))}`)
        .replace(
          '"directory": "./admin/dist"',
          `"directory": ${JSON.stringify(join(root, 'admin/dist'))}`,
        )
        .replace(
          '"migrations_dir": "drizzle"',
          `"migrations_dir": ${JSON.stringify(join(root, 'drizzle'))}`,
        ),
    );
    const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
    const flags = ['--config', config, '--env-file', envFile, '--local', '--persist-to', persist];
    const sql = async (statement: string) =>
      command('isolated fixture SQL', [
        cli,
        'd1',
        'execute',
        'DB',
        ...flags,
        '--command',
        statement,
      ]);
    await command('isolated migrations', [cli, 'd1', 'migrations', 'apply', 'DB', ...flags]);
    const port = await availablePort();
    const base = `http://127.0.0.1:${String(port)}`;
    const processState = { spawnFailed: false };
    worker = spawn(
      process.execPath,
      [cli, 'dev', ...flags, '--ip', '127.0.0.1', '--port', String(port)],
      {
        cwd: root,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
      },
    );
    worker.once('error', () => {
      processState.spawnFailed = true;
    });
    const http = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
    let ready = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      assert(
        !processState.spawnFailed && worker.exitCode === null && worker.signalCode === null,
        'Worker stays running',
      );
      try {
        const health = await http('/v1/health');
        await health.arrayBuffer();
        ready = health.ok;
      } catch {
        /* Still starting. */
      }
      if (ready) break;
      await pause(250);
    }
    assert(ready, 'Worker readiness within 60 seconds');
    const password = 'isolated-browser-credential-41';
    const admin = 'qa-admin@example.com';
    const regular = 'qa-user@example.com';
    const unverified = 'qa-unverified@example.com';
    for (const [path, name, email] of [
      ['/v1/auth/admin/bootstrap', 'QA Administrator', admin],
      ['/v1/auth/register', 'QA User', regular],
      ['/v1/auth/register', 'QA Unverified', unverified],
    ]) {
      const response = await http(path ?? '', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      assert(response.status === 201, 'fixture created through public HTTP');
      await response.arrayBuffer();
    }
    // Actual verify-email transitions are covered by Workers-runtime tests.
    await sql(`UPDATE "user" SET email_verified = 1 WHERE email IN ('${admin}', '${regular}')`);
    phase = 'assets';
    for (const path of ['/admin', '/admin/', '/admin/login']) {
      const response = await http(path);
      assert(
        response.status === 200 && response.headers.get('content-type')?.includes('text/html'),
        'SPA deep links return HTML',
      );
      const html = await response.text();
      for (const asset of html.matchAll(/(?:src|href)="(\/admin\/assets\/[^"]+)"/g)) {
        const result = await http(asset[1] ?? '');
        assert(
          result.ok && !result.headers.get('content-type')?.includes('text/html'),
          'built scripts/styles resolve',
        );
        await result.arrayBuffer();
      }
    }
    const missingAsset = await http('/admin/assets/not-a-real-hash.js');
    assert(missingAsset.status === 404, 'missing hashed asset stays 404');
    await missingAsset.arrayBuffer();
    const unknown = await http('/v1/not-a-real-operation');
    assert(
      unknown.status === 404 &&
        unknown.headers.get('content-type')?.includes('application/problem+json'),
      'unknown API remains JSON',
    );
    await unknown.arrayBuffer();
    const action = await http('/auth-actions/verify-email');
    assert(
      action.status === 200 && action.headers.get('content-type')?.includes('text/html'),
      'existing auth action remains HTML',
    );
    await action.arrayBuffer();

    const executablePath = [
      process.env.CHROME_PATH,
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((path) => path !== undefined && existsSync(path));
    if (executablePath === undefined)
      await command('pinned Chromium installation', [
        join(root, 'node_modules/playwright-core/cli.js'),
        'install',
        'chromium',
        '--only-shell',
      ]);
    browser = await chromium.launch({
      ...(executablePath === undefined ? {} : { executablePath }),
      headless: true,
      timeout: 30_000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    diagnosticPage = page;
    page.setDefaultTimeout(15_000);
    phase = 'administrator login';
    await page.goto(`${base}/admin/unknown-route`);
    await visible(page, 'Administración');
    await page.keyboard.press('Tab');
    assert(
      await page.evaluate<boolean>(`(() => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active !== document.body && getComputedStyle(active).outlineStyle !== 'none';
    })()`),
      'keyboard focus visible',
    );
    await signIn(page, admin, 'wrong-password-99');
    await page.getByRole('alert').filter({ hasText: 'Credenciales inválidas' }).waitFor();
    await signIn(page, admin, password);
    await visible(page, 'Sesión de administración');
    await page.getByText(admin, { exact: true }).first().waitFor();
    await page.getByText('Correo verificado', { exact: true }).waitFor();
    await page.reload();
    await visible(page, 'Sesión de administración');
    await page.goto(`${base}/admin/unknown-route`);
    await visible(page, 'Página no encontrada');
    assert(
      (await page.getByRole('button', { name: 'Menú de usuario', exact: true }).count()) === 1,
      'unknown route has a single kit layout',
    );
    await page.getByRole('link', { name: 'Volver al inicio', exact: true }).click();
    await visible(page, 'Sesión de administración');
    const cookies = await context.cookies();
    const token = cookies.find((cookie) => cookie.name.endsWith('session_token'));
    assert(token?.httpOnly, 'browser stores HttpOnly session');
    const credentials = JSON.stringify({ password, token: token.value });
    assert(
      await page.evaluate<boolean>(`(() => {
      const credentials = ${credentials};
      const stored = [...Object.values(localStorage), ...Object.values(sessionStorage)].join(' ');
      return !stored.includes(credentials.password) && !stored.includes(credentials.token) && !document.cookie.includes('session_token');
    })()`),
      'UI storage contains no password or session token',
    );
    const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    for (const [path, fields] of [
      ['/v1/me', ['email', 'emailVerified', 'id']],
      ['/v1/admin/me', ['email', 'emailVerified', 'id', 'role']],
    ] as const) {
      const response = await http(path, { headers: { cookie: cookieHeader } });
      assert(response.status === 200, 'authenticated HTTP identity');
      const payload: unknown = await response.json();
      assert(
        typeof payload === 'object' &&
          payload !== null &&
          Object.keys(payload).sort().join(',') === fields.join(','),
        'exact application-owned identity fields',
      );
    }
    phase = 'retryable service failure';
    await sql('ALTER TABLE "session" RENAME TO "session_qa_unavailable"');
    try {
      await page.reload();
      await visible(page, 'El servicio no está disponible');
      assert(
        (await context.cookies()).some(
          (cookie) => cookie.name === token.name && cookie.value === token.value,
        ),
        'server failure preserves cookie',
      );
    } finally {
      await sql('ALTER TABLE "session_qa_unavailable" RENAME TO "session"');
    }
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await visible(page, 'Sesión de administración');
    phase = 'administrator logout';
    await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await visible(page, 'Administración');
    for (const path of ['/v1/me', '/v1/admin/me']) {
      const response = await http(path, { headers: { cookie: cookieHeader } });
      assert(response.status === 401, 'logout revokes old cookie');
      await response.arrayBuffer();
    }
    await page.goto(`${base}/admin/`);
    await visible(page, 'Administración');
    phase = 'regular User login and denial';
    await signIn(page, regular, password);
    await visible(page, 'Acceso denegado');
    await page.reload();
    await visible(page, 'Acceso denegado');
    await page.goto(`${base}/admin/unknown-route`);
    await visible(page, 'Acceso denegado');
    assert(
      (await page.getByRole('button', { name: 'Menú de usuario', exact: true }).count()) === 0,
      'denied route does not expose administrative layout',
    );
    const regularResponse = await context.request.get(`${base}/v1/me`);
    assert(regularResponse.status() === 200, '403 denial preserves regular User session');
    const deniedResponse = await context.request.get(`${base}/v1/admin/me`);
    assert(deniedResponse.status() === 403, 'server remains permission authority');
    await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await visible(page, 'Administración');
    phase = 'unverified login';
    await signIn(page, unverified, password);
    await page.getByRole('alert').filter({ hasText: 'Verifica tu correo electrónico' }).waitFor();
    phase = 'expired session';
    await signIn(page, admin, password);
    await visible(page, 'Sesión de administración');
    await sql('UPDATE "session" SET expires_at = 0');
    await page.reload();
    await visible(page, 'Administración');
    const expired = await context.request.get(`${base}/v1/admin/me`);
    assert(expired.status() === 401, 'expired cookie is rejected');
    phase = 'expiry between authorization and identity';
    await signIn(page, admin, password);
    await visible(page, 'Sesión de administración');
    let identityReads = 0;
    await page.route('**/v1/admin/me', async (route) => {
      identityReads++;
      if (identityReads === 2) await sql('UPDATE "session" SET expires_at = 0');
      await route.continue();
    });
    // Delay only a real request to mutate isolated D1 between the two reads;
    // no response is fulfilled or mocked.
    await page.reload();
    await visible(page, 'Administración');
    assert(identityReads >= 2, 'identity read observes expiration after authorization');
    await page.unroute('**/v1/admin/me');
    phase = 'mobile layout';
    await page.setViewportSize({ width: 360, height: 740 });
    await page.reload();
    await visible(page, 'Administración');
    assert(
      await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'),
      'narrow login fits viewport',
    );
    await context.close();
    console.log(
      'Administration browser acceptance passed: admin, regular denial, retry, expiry, logout, routing and keyboard/mobile.',
    );
  } catch (cause) {
    if (diagnosticPage !== undefined && !diagnosticPage.isClosed()) {
      const summary = await Promise.race([
        diagnosticPage
          .evaluate<string>(
            `JSON.stringify({
        path: location.pathname,
        headings: [...document.querySelectorAll('h1')].map(node => node.textContent),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent)
      })`,
          )
          .catch(() => 'Page diagnostics unavailable'),
        pause(2000).then(() => 'Page diagnostics timed out'),
      ]);
      // Only fixed UI labels; fixture emails are redacted and no form values,
      // cookies, storage, response bodies or action URLs are inspected here.
      console.info(
        'Administration browser state:',
        summary.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[fixture]').slice(0, 1000),
      );
    }
    throw new Error(`Administration browser acceptance failed during ${phase}`, { cause });
  } finally {
    try {
      await browser?.close();
    } finally {
      if (worker !== undefined) await stopWorker(worker);
      await rm(state, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAdminBrowserTest().catch(() => {
    // Raw browser/transport exceptions can carry fixture values; no raw output.
    console.error(
      'Administration browser acceptance failed. Run the test harness for its bounded stage report.',
    );
    process.exitCode = 1;
  });
}
