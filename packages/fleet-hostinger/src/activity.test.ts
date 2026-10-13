import { test } from "node:test";
import assert from "node:assert/strict";
import { toActivityFailure } from "./activity.js";
import { HostingerApiError, FleetError } from "./errors.js";

// Spec 0012 — activity-shaped error mapping (plan step 7). The `todo`s become
// real assertions when `toActivityFailure` lands. Sanity here that the typed
// errors carry the `retryable` contract the mapping keys off.

test("typed errors expose the retryable flag the mapping reads", () => {
  assert.equal(new HostingerApiError("server", "boom", { retryable: true }).retryable, true);
  assert.equal(new FleetError("config", "bad input", { retryable: false }).retryable, false);
});

test("maps a retryable HostingerApiError (429/5xx/timeout) to retryable=true", () => {
  const err = new HostingerApiError("rate_limited", "429 too many requests", {
    status: 429,
    retryable: true,
  });
  const failure = toActivityFailure(err);
  assert.equal(failure.type, "HostingerApiError:rate_limited");
  assert.equal(failure.message, "429 too many requests");
  assert.equal(failure.retryable, true);
});

test("maps a fatal HostingerApiError (auth/404/other 4xx) to retryable=false", () => {
  const err = new HostingerApiError("auth", "401 unauthorized", { status: 401, retryable: false });
  const failure = toActivityFailure(err);
  assert.equal(failure.type, "HostingerApiError:auth");
  assert.equal(failure.message, "401 unauthorized");
  assert.equal(failure.retryable, false);
});

test("maps FleetError to a descriptor carrying its own retryable flag", () => {
  const retryableErr = new FleetError("ssh", "connection refused", { retryable: true });
  const fatalErr = new FleetError("config", "missing DOMAIN placeholder", { retryable: false });
  assert.deepEqual(toActivityFailure(retryableErr), {
    type: "FleetError:ssh",
    message: "connection refused",
    retryable: true,
  });
  assert.deepEqual(toActivityFailure(fatalErr), {
    type: "FleetError:config",
    message: "missing DOMAIN placeholder",
    retryable: false,
  });
});

test("maps an unknown error to a fatal (non-retryable) descriptor", () => {
  const plainError = toActivityFailure(new Error("plain boom"));
  assert.equal(plainError.type, "Unknown");
  assert.equal(plainError.message, "plain boom");
  assert.equal(plainError.retryable, false);

  const nonError = toActivityFailure("thrown a string, not an Error");
  assert.equal(nonError.type, "Unknown");
  assert.equal(nonError.retryable, false);
});

test("never includes secret material (token / key / db password) in the descriptor", () => {
  const secret = "sk-super-secret-token-do-not-leak";
  // The secret lives on `.cause`, never in `.message` — the mapping must only
  // ever read `.message`, never spread `.cause` or other properties, since
  // `.cause` can carry raw SSH stderr / API response bodies that aren't
  // guaranteed secret-free the way a constructed error's `.message` is.
  const err = new FleetError("ssh", "writeFile failed (exit 1)", {
    retryable: true,
    cause: new Error(`leaked token: ${secret}`),
  });
  const failure = toActivityFailure(err);
  const serialized = JSON.stringify(failure);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.deepEqual(Object.keys(failure).sort(), ["message", "retryable", "type"]);
});
