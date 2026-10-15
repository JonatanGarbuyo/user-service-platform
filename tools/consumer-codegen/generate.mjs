import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

// Isolate the generator's supported TypeScript 5 peer from the application's
// pinned TypeScript 6 compiler. Ordinary npm ci installs both without peer
// overrides; the emitted contracts are checked by the application compiler.
const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  throw new Error('Expected absolute OpenAPI input and generated output paths.');
}
const nodes = await openapiTS(pathToFileURL(input));
await writeFile(output, astToString(nodes));
