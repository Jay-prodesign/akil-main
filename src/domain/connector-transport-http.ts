import { execFileSync } from "node:child_process";
import type { ConnectorKind } from "./integration-connector-catalog.js";
import type {
  ConnectorTransport,
  ConnectorTransportRequest,
  ConnectorTransportResponse,
} from "./connector-execution.js";

/**
 * `connector-execution.ts`'s own `ConnectorTransport.execute` is
 * deliberately SYNCHRONOUS (`(request) => ConnectorTransportResponse`, not a
 * `Promise`) - every mock transport in this repository's test suite already
 * relies on that, and `executeConnectorCapability` calls it with no `await`
 * anywhere. Node has no built-in synchronous network I/O, so a real adapter
 * against this exact interface cannot use `fetch`/`node:https` directly
 * without either blocking the event loop in an unsupported way or widening
 * `ConnectorTransport` to return a `Promise` - which would be a genuine,
 * new architecture decision touching an already multiply-Brain-reviewed
 * module (`connector-execution.ts`) and every one of its existing callers,
 * not "dark/internal adapter implementation."
 *
 * This adapter honors the existing interface exactly as written instead:
 * `node:child_process.execFileSync("curl", ...)` performs one real,
 * genuinely synchronous HTTP request per call, with zero new runtime
 * dependency (curl is a subprocess, not an npm package) and zero change to
 * `connector-execution.ts` or anything that already calls it. This is
 * precisely the Rev94 F3 floor: "dark/internal adapter implementation...
 * NOT gated - real credential ACTIVATION is." No credential is wired to
 * this adapter by this module itself; `authSecretValue` is supplied by the
 * caller (via `executeConnectorCapability`'s own `SecretResolver` boundary)
 * at the moment of execution, exactly like every other transport.
 *
 * Per-connector-kind auth header convention: `ANTHROPIC` uses `x-api-key` +
 * a pinned `anthropic-version` header (its documented API_KEY convention);
 * every other connector kind defaults to `Authorization: Bearer
 * <authSecretValue>` (the common OAuth2/API_KEY bearer convention already
 * implied by `ConnectorAuthMode`). Extend this mapping as further concrete
 * providers are activated - never invent one generically "good enough" for
 * all of them, since providers genuinely differ here.
 */
export class HttpConnectorTransportError extends Error {
  constructor(reason: string) {
    super(`HttpConnectorTransport error: ${reason}`);
    this.name = "HttpConnectorTransportError";
  }
}

export interface HttpConnectorTransportDeps {
  /**
   * Injectable for tests - defaults to a real `execFileSync("curl", ...)`
   * call. Never invoked by this module's own test suite with the real
   * default, so no test in this repository ever performs a live network
   * call.
   */
  readonly runCurl?: (args: ReadonlyArray<string>) => string;
}

function authHeadersFor(connectorKind: ConnectorKind, authSecretValue: string): ReadonlyArray<string> {
  if (connectorKind === "ANTHROPIC") {
    return [
      "-H", `x-api-key: ${authSecretValue}`,
      "-H", "anthropic-version: 2023-06-01",
    ];
  }
  return ["-H", `Authorization: Bearer ${authSecretValue}`];
}

const CURL_STATUS_DELIMITER = "\n__AKILTA_HTTP_STATUS__:";

/**
 * Real, genuinely synchronous HTTP transport. Never performs a network call
 * in this module's own tests (`runCurl` is always a deterministic double
 * there) - only a caller that constructs this with no `deps.runCurl`
 * override, outside a test, ever shells out for real.
 */
export class HttpConnectorTransport implements ConnectorTransport {
  private readonly runCurl: (args: ReadonlyArray<string>) => string;

  constructor(deps: HttpConnectorTransportDeps = {}) {
    this.runCurl =
      deps.runCurl ??
      ((args) => execFileSync("curl", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }));
  }

  execute(request: ConnectorTransportRequest): ConnectorTransportResponse {
    if (request.baseUrl === undefined) {
      return {
        outcome: "TRANSPORT_ERROR",
        errorMessage: "no baseUrl resolved for this endpoint - cannot construct a request URL",
      };
    }
    const url = `${request.baseUrl.replace(/\/+$/, "")}${request.path}`;
    const args: string[] = [
      "-s",
      "-S",
      "--max-time",
      "30",
      "-w",
      `${CURL_STATUS_DELIMITER}%{http_code}`,
      "-X",
      request.method,
      ...authHeadersFor(request.connectorKind, request.authSecretValue),
      "-H",
      "content-type: application/json",
    ];
    if (request.requestPayload !== undefined) {
      args.push("-d", JSON.stringify(request.requestPayload));
    }
    args.push(url);

    let raw: string;
    try {
      raw = this.runCurl(args);
    } catch (cause) {
      // Never forward the subprocess's own stderr/message verbatim - it may
      // echo back request content, mirroring `connector-execution.ts`'s own
      // "never echo resolver/transport free text" discipline (OS-V0-15 #13).
      return {
        outcome: "TRANSPORT_ERROR",
        errorMessage: `curl invocation failed for capability "${request.capabilityRef}"`,
      };
    }

    const delimiterIndex = raw.lastIndexOf(CURL_STATUS_DELIMITER);
    if (delimiterIndex === -1) {
      return { outcome: "TRANSPORT_ERROR", errorMessage: "malformed curl output: missing status delimiter" };
    }
    const body = raw.slice(0, delimiterIndex);
    const statusCode = Number(raw.slice(delimiterIndex + CURL_STATUS_DELIMITER.length).trim());
    if (!Number.isInteger(statusCode)) {
      return { outcome: "TRANSPORT_ERROR", errorMessage: "malformed curl output: non-numeric status code" };
    }

    if (statusCode === 401 || statusCode === 403) {
      return { outcome: "AUTHORIZATION_FAILED" };
    }
    if (statusCode < 200 || statusCode >= 300) {
      return { outcome: "TRANSPORT_ERROR", errorMessage: `upstream returned HTTP ${statusCode}` };
    }

    let data: unknown;
    try {
      data = body.length > 0 ? JSON.parse(body) : undefined;
    } catch {
      return { outcome: "TRANSPORT_ERROR", errorMessage: "upstream response body was not valid JSON" };
    }
    return { outcome: "SUCCESS", ...(data !== undefined ? { data } : {}) };
  }
}

/**
 * Anthropic Messages API's own documented response shape: the generated
 * text lives at `content[0].text` when `content[0].type === "text"`. This
 * extractor never assumes - it fails closed with `undefined` (never throws,
 * so a caller decides how to treat "no extractable text") on any shape
 * deviation, since the raw `data` is untrusted response material from an
 * external provider.
 */
export function extractAnthropicMessageText(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const content = (data as Record<string, unknown>)["content"];
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const first = content[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const block = first as Record<string, unknown>;
  if (block["type"] !== "text" || typeof block["text"] !== "string" || block["text"].length === 0) {
    return undefined;
  }
  return block["text"];
}
