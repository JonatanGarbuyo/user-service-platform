import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { openApiConfig } from '../../src/openapi.js';

// Seam under test: the generated OpenAPI artifact (ticket #9). These tests prove
// that the committed document describes the public operations and that
// regeneration from source contracts is byte-deterministic, so CI drift checks
// are meaningful.
const artifactPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'openapi',
  'openapi.json',
);

describe('generated OpenAPI artifact', () => {
  it('describes the health operation', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    expect(document.openapi).toMatch(/^3\.1\./);
    expect(document.paths['/v1/health']?.get?.operationId).toBe('getHealth');
  });

  it('regenerates byte-identically from source contracts', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const regenerated = `${JSON.stringify(createApp().getOpenAPI31Document(openApiConfig), null, 2)}\n`;

    expect(regenerated).toBe(raw);
  });
});
