import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openApiConfig } from '../src/openapi.js';

// Regenerates the committed OpenAPI artifact from the application-owned source
// contracts. The output is deterministic: the same source always yields the same
// bytes, so CI can fail on drift (`npm run openapi:check`). Never hand-edit
// `openapi/openapi.json`.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = resolve(root, 'openapi', 'openapi.json');

const document = createApp().getOpenAPI31Document(openApiConfig);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`);

console.log(`OpenAPI document written to ${outPath}`);
