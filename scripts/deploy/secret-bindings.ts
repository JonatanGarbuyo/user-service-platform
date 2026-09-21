// Required-secret binding-type verification (ticket #106, parent #14).
//
// Live evidence after #104 showed `secrets.required` accepts a same-name
// plaintext Worker `vars` entry, and Wrangler then printed those values in the
// deploy diff. Presence by name is therefore not sufficient: deployment
// preflight must verify every required secret name exists specifically as a
// Cloudflare `secret_text` binding before `wrangler deploy` and smoke.
//
// Secret boundary: this module consumes only the provider-supported
// names/types-only listing (`wrangler secret list --format json
// --name <worker>`, entries shaped like `{ name, type: "secret_text" }`
// without secret values). It reads `name`/`type` fields only, never value
// fields, and failure output carries required names/status only — no values,
// remote config diff, credentials, email addresses, tokens, or other binding
// values. A plaintext `vars` binding with the same name never satisfies the
// check.
export const SECRET_TEXT_TYPE = 'secret_text';

export interface RemoteSecretBinding {
  readonly name: string;
  readonly type: string;
}

export type SecretBindingStatus = 'ok' | 'missing' | 'wrong-type';

export interface SecretBindingResult {
  readonly name: string;
  readonly status: SecretBindingStatus;
}

// Builds the provider-supported names/types-only listing invocation for a
// target Worker. Values are never requested; the command returns entries
// shaped like `{ name, type: "secret_text" }`.
export function secretListArgs(workerName: string): readonly string[] {
  return ['wrangler', 'secret', 'list', '--format', 'json', '--name', workerName];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Parses the names/types-only provider output, keeping `name`/`type` pairs
// only. Unknown extra fields (including any value-shaped fields a future
// provider might add) are dropped, never consumed or logged. Non-array output
// fails closed with a fixed message that echoes nothing from the provider.
export function parseSecretListOutput(stdout: string): RemoteSecretBinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('Unable to verify required Worker secrets: unexpected secret list output.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Unable to verify required Worker secrets: unexpected secret list output.');
  }
  const bindings: RemoteSecretBinding[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      continue;
    }
    const name: unknown = entry.name;
    const type: unknown = entry.type;
    if (typeof name === 'string' && typeof type === 'string') {
      bindings.push({ name, type });
    }
  }
  return bindings;
}

// Verifies each required name in order against the remote names/types-only
// listing. A required name counts only when present with exactly type
// `secret_text`; a same-name plaintext `vars` entry (or any other type)
// reports `wrong-type`, an absent name reports `missing`, and unrelated extra
// secrets are ignored.
export function checkSecretTextBindings(
  required: readonly string[],
  remote: readonly RemoteSecretBinding[],
): SecretBindingResult[] {
  return required.map((name) => {
    const match = remote.find((entry) => entry.name === name);
    if (match === undefined) {
      return { name, status: 'missing' as const };
    }
    if (match.type !== SECRET_TEXT_TYPE) {
      return { name, status: 'wrong-type' as const };
    }
    return { name, status: 'ok' as const };
  });
}

export function secretBindingsFailed(results: readonly SecretBindingResult[]): boolean {
  return results.some((result) => result.status !== 'ok');
}

// Formats failures with required names/status only. `results` carries names
// and statuses by construction, so values cannot leak through this message.
export function formatSecretBindingsError(
  workerName: string,
  results: readonly SecretBindingResult[],
): Error {
  const failures = results
    .filter((result) => result.status !== 'ok')
    .map((result) =>
      result.status === 'missing'
        ? `${result.name} (missing)`
        : `${result.name} (not ${SECRET_TEXT_TYPE})`,
    );
  return new Error(
    `Required Worker secrets are not ${SECRET_TEXT_TYPE} bindings on "${workerName}": ${failures.join(', ')}. Recreate them as Cloudflare Secrets, not Variables.`,
  );
}
