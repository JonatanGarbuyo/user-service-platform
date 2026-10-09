import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Seam under test (ticket #124, ADR-0007, ADR-0012): the published OpenAPI
// contract behind the administration SPA plus the SPA's HTTP client source.
// These tests prove the SPA consumes the application-owned contracts without
// duplicating API schemas (exact `AdminMe` shape, reused login/sign-out
// operations) and that the client never persists authentication material in
// browser storage. Expected values come from the committed OpenAPI artifact,
// not from the client implementation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifactPath = resolve(root, 'openapi', 'openapi.json');
const clientPath = resolve(root, 'admin', 'src', 'api.ts');

interface Operation {
  readonly operationId?: string;
  readonly responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

async function document(): Promise<{
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
}> {
  const raw = await readFile(artifactPath, 'utf8');
  return JSON.parse(raw) as {
    paths: Record<string, Record<string, Operation>>;
    components: {
      schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    };
  };
}

describe('administration API contract', () => {
  it('publishes GET /v1/admin/me with the exact administrative representation', async () => {
    const doc = await document();

    const operation = doc.paths['/v1/admin/me']?.get;
    expect(operation?.operationId).toBe('getAdminMe');

    const schema = operation?.responses?.['200']?.content?.['application/json']?.schema as
      | { $ref?: string }
      | undefined;
    expect(schema?.$ref).toBe('#/components/schemas/AdminMe');

    const adminMe = doc.components.schemas.AdminMe;
    expect(adminMe?.required?.slice().sort()).toEqual([
      'email',
      'emailVerified',
      'id',
      'role',
    ]);
    expect(Object.keys(adminMe?.properties ?? {}).sort()).toEqual([
      'email',
      'emailVerified',
      'id',
      'role',
    ]);
  });

  it('reuses the existing login and sign-out operations unchanged', async () => {
    const doc = await document();

    expect(doc.paths['/v1/auth/login']?.post?.operationId).toBe('loginIdentity');
    expect(doc.paths['/v1/auth/sign-out']?.post?.operationId).toBe('signOutIdentity');
    // The session check reuses the unchanged public contract, which gains no
    // administrative fields for the panel's convenience.
    expect(doc.paths['/v1/me']?.get?.operationId).toBe('getCurrentUser');
  });

  it('keeps the SPA client on the published contracts without browser token storage', async () => {
    const raw = await readFile(clientPath, 'utf8');
    // Strip comments so prose about the storage ban cannot trip the guard;
    // only executable code is inspected.
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');

    // The client talks to exactly the application-owned contracts above.
    expect(source).toContain("'/v1/auth/login'");
    expect(source).toContain("'/v1/admin/me'");
    expect(source).toContain("'/v1/auth/sign-out'");
    expect(source).toContain("'/v1/me'");
    expect(source).toContain("credentials: 'include'");

    // Authentication tokens must never be read, copied or persisted in
    // browser storage: the session travels only in the HttpOnly cookie.
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('sessionStorage');
    expect(source).not.toContain('document.cookie');
  });
});
