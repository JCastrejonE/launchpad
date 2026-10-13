import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHttpStatus } from "./errors.js";

test("classifyHttpStatus maps 401/403 to auth, fatal", () => {
  assert.deepEqual(classifyHttpStatus(401), { kind: "auth", retryable: false });
  assert.deepEqual(classifyHttpStatus(403), { kind: "auth", retryable: false });
});

test("classifyHttpStatus maps 404 to not_found, fatal", () => {
  assert.deepEqual(classifyHttpStatus(404), { kind: "not_found", retryable: false });
});

test("classifyHttpStatus maps 429 to rate_limited, retryable", () => {
  assert.deepEqual(classifyHttpStatus(429), { kind: "rate_limited", retryable: true });
});

test("classifyHttpStatus maps 5xx to server, retryable", () => {
  assert.deepEqual(classifyHttpStatus(500), { kind: "server", retryable: true });
  assert.deepEqual(classifyHttpStatus(503), { kind: "server", retryable: true });
});

test("classifyHttpStatus maps other 4xx to client, fatal", () => {
  assert.deepEqual(classifyHttpStatus(400), { kind: "client", retryable: false });
  assert.deepEqual(classifyHttpStatus(422), { kind: "client", retryable: false });
});
