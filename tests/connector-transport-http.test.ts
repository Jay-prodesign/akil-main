import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HttpConnectorTransport,
  extractAnthropicMessageText,
} from "../src/domain/connector-transport-http.js";
import type { ConnectorTransportRequest } from "../src/domain/connector-execution.js";

const STATUS_DELIM = "\n__AKILTA_HTTP_STATUS__:";

function baseRequest(overrides: Partial<ConnectorTransportRequest> = {}): ConnectorTransportRequest {
  return {
    connectorKind: "ANTHROPIC",
    connectionBindingId: "binding-1" as ConnectorTransportRequest["connectionBindingId"],
    capabilityRef: "cap:anthropic-model-inference" as ConnectorTransportRequest["capabilityRef"],
    method: "POST",
    path: "/messages",
    baseUrl: "https://api.anthropic.com/v1",
    authSecretValue: "sk-test-secret-value",
    requestPayload: { model: "claude-test", messages: [] },
    ...overrides,
  };
}

function withoutBaseUrl(request: ConnectorTransportRequest): ConnectorTransportRequest {
  const { baseUrl, ...rest } = request;
  return rest;
}

test("execute: a 200 response with a JSON body returns SUCCESS with the parsed data", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const transport = new HttpConnectorTransport({
    runCurl: (args) => {
      calls.push(args);
      return `{"content":[{"type":"text","text":"hello"}]}${STATUS_DELIM}200`;
    },
  });
  const response = transport.execute(baseRequest());
  assert.equal(response.outcome, "SUCCESS");
  assert.deepEqual(response.data, { content: [{ type: "text", text: "hello" }] });
  assert.equal(calls.length, 1);
});

test("execute: builds the correct curl invocation - method, URL, ANTHROPIC auth headers, JSON payload", () => {
  let capturedArgs: ReadonlyArray<string> = [];
  const transport = new HttpConnectorTransport({
    runCurl: (args) => {
      capturedArgs = args;
      return `{}${STATUS_DELIM}200`;
    },
  });
  transport.execute(baseRequest());

  assert.equal(capturedArgs[capturedArgs.length - 1], "https://api.anthropic.com/v1/messages");
  assert.ok(capturedArgs.includes("-X"));
  assert.equal(capturedArgs[capturedArgs.indexOf("-X") + 1], "POST");
  assert.ok(capturedArgs.includes("x-api-key: sk-test-secret-value"));
  assert.ok(capturedArgs.includes("anthropic-version: 2023-06-01"));
  assert.ok(capturedArgs.includes("content-type: application/json"));
  const payloadIndex = capturedArgs.indexOf("-d");
  assert.ok(payloadIndex !== -1);
  assert.equal(capturedArgs[payloadIndex + 1], JSON.stringify({ model: "claude-test", messages: [] }));
});

test("execute: a non-ANTHROPIC connector kind uses a Bearer Authorization header instead", () => {
  let capturedArgs: ReadonlyArray<string> = [];
  const transport = new HttpConnectorTransport({
    runCurl: (args) => {
      capturedArgs = args;
      return `{}${STATUS_DELIM}200`;
    },
  });
  transport.execute(baseRequest({ connectorKind: "OPENAI", baseUrl: "https://api.openai.com/v1", path: "/chat/completions" }));
  assert.ok(capturedArgs.includes("Authorization: Bearer sk-test-secret-value"));
  assert.ok(!capturedArgs.includes("x-api-key: sk-test-secret-value"));
});

test("execute: 401 and 403 upstream status map to AUTHORIZATION_FAILED, never TRANSPORT_ERROR", () => {
  for (const status of [401, 403]) {
    const transport = new HttpConnectorTransport({ runCurl: () => `{"error":"nope"}${STATUS_DELIM}${status}` });
    const response = transport.execute(baseRequest());
    assert.equal(response.outcome, "AUTHORIZATION_FAILED");
    assert.equal(response.data, undefined, "AUTHORIZATION_FAILED never surfaces the response body as data");
  }
});

test("execute: any other non-2xx upstream status maps to TRANSPORT_ERROR", () => {
  const transport = new HttpConnectorTransport({ runCurl: () => `{}${STATUS_DELIM}500` });
  const response = transport.execute(baseRequest());
  assert.equal(response.outcome, "TRANSPORT_ERROR");
  assert.match(response.errorMessage ?? "", /500/);
});

test("execute: a 2xx with an empty body is SUCCESS with no data field", () => {
  const transport = new HttpConnectorTransport({ runCurl: () => `${STATUS_DELIM}204` });
  const response = transport.execute(baseRequest());
  assert.equal(response.outcome, "SUCCESS");
  assert.equal("data" in response, false);
});

test("execute: a non-JSON 2xx body fails closed as TRANSPORT_ERROR rather than throwing or returning raw text as data", () => {
  const transport = new HttpConnectorTransport({ runCurl: () => `not json at all${STATUS_DELIM}200` });
  const response = transport.execute(baseRequest());
  assert.equal(response.outcome, "TRANSPORT_ERROR");
});

test("execute: missing status delimiter in curl output fails closed as TRANSPORT_ERROR", () => {
  const transport = new HttpConnectorTransport({ runCurl: () => "garbage with no delimiter" });
  const response = transport.execute(baseRequest());
  assert.equal(response.outcome, "TRANSPORT_ERROR");
});

test("execute: no baseUrl resolved fails closed as TRANSPORT_ERROR before any curl invocation", () => {
  let invoked = false;
  const transport = new HttpConnectorTransport({ runCurl: () => { invoked = true; return ""; } });
  const response = transport.execute(withoutBaseUrl(baseRequest()));
  assert.equal(response.outcome, "TRANSPORT_ERROR");
  assert.equal(invoked, false);
});

test("execute: a throwing runCurl never forwards its own message - the thrown detail is never leaked into errorMessage", () => {
  const transport = new HttpConnectorTransport({
    runCurl: () => {
      throw new Error("leaked-secret-value-should-never-appear sk-test-secret-value");
    },
  });
  const response = transport.execute(baseRequest());
  assert.equal(response.outcome, "TRANSPORT_ERROR");
  assert.ok(!(response.errorMessage ?? "").includes("sk-test-secret-value"));
  assert.ok(!(response.errorMessage ?? "").includes("leaked-secret-value-should-never-appear"));
});

// --- extractAnthropicMessageText ---

test("extractAnthropicMessageText: extracts the text block from a well-formed Anthropic Messages response", () => {
  const data = { content: [{ type: "text", text: "Generated website copy." }] };
  assert.equal(extractAnthropicMessageText(data), "Generated website copy.");
});

test("extractAnthropicMessageText: returns undefined (never throws) for any shape deviation", () => {
  const badShapes: ReadonlyArray<unknown> = [
    undefined,
    null,
    "a string",
    {},
    { content: [] },
    { content: "not an array" },
    { content: [{ type: "image" }] },
    { content: [{ type: "text", text: "" }] },
    { content: [{ type: "text" }] },
    { content: [null] },
  ];
  for (const shape of badShapes) {
    assert.equal(extractAnthropicMessageText(shape), undefined, JSON.stringify(shape));
  }
});
