import type { SecretResolver } from "./connector-execution.js";

/**
 * The simplest real `SecretResolver` honest for this repository's current
 * durability tier: a `secretRef` id is resolved to the environment variable
 * of the exact same name. No KMS/Vault integration exists yet (D2/D3's own
 * gap) - this is the dark/internal floor REV94 F3 names as not gated, ready
 * to be swapped for a real secret-manager-backed resolver later without any
 * caller of `SecretResolver` changing, exactly like `ConnectorTransport`'s
 * own mock-vs-real swap.
 *
 * Deliberately does not log, echo, or include the resolved value anywhere -
 * only the opaque `secretRefId` ever appears in a thrown message, matching
 * `connector-execution.ts`'s own "never forward the resolver's own message
 * verbatim" discipline one layer earlier (defense in depth: even if that
 * caller-side protection were ever removed, this resolver's own errors
 * carry no secret material to begin with).
 */
export class MissingEnvSecretError extends Error {
  constructor(secretRefId: string) {
    super(`No environment variable named "${secretRefId}" is set - cannot resolve this secretRef`);
    this.name = "MissingEnvSecretError";
  }
}

export class EnvSecretResolver implements SecretResolver {
  resolve(secretRefId: string): string {
    const value = process.env[secretRefId];
    if (value === undefined || value.length === 0) {
      throw new MissingEnvSecretError(secretRefId);
    }
    return value;
  }
}
