import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBaseUrl } from "./client.js";

test("resolveBaseUrl returns an explicit baseUrl as-is", () => {
  assert.equal(
    resolveBaseUrl({ apiToken: "t", baseUrl: "https://example.test/api" }),
    "https://example.test/api",
  );
});

test("resolveBaseUrl falls back to the documented default when baseUrl is missing", () => {
  assert.equal(
    resolveBaseUrl({ apiToken: "t" }),
    "https://developers.hostinger.com/api/vps/v1",
  );
});
