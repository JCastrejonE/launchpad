import { test } from "node:test";
import assert from "node:assert/strict";
import { credentialEnv } from "./credentials.js";

test("credentialEnv maps subscription mode to CLAUDE_CODE_OAUTH_TOKEN", () => {
  assert.deepEqual(credentialEnv({ mode: "subscription", oauthToken: "tok-123" }), {
    CLAUDE_CODE_OAUTH_TOKEN: "tok-123",
  });
});

test("credentialEnv maps api-key mode to ANTHROPIC_API_KEY", () => {
  assert.deepEqual(credentialEnv({ mode: "api-key", apiKey: "sk-abc" }), {
    ANTHROPIC_API_KEY: "sk-abc",
  });
});
