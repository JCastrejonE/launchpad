import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserRow } from "@launchpad/db";
import {
  authorizeUser,
  normalizeEmail,
  sessionRoleFromToken,
  TIMING_EQUALIZER_HASH,
  tokenWithUser,
  type AuthorizeDeps,
} from "./auth-core.js";

const OWNER_ROW: UserRow = {
  id: "u-1",
  email: "owner@example.com",
  name: "Owner",
  role: "OWNER",
  passwordHash: "scrypt$stored$hash",
  // Spec 0128 B: null until this row is claimed by a GitHub identity.
  githubLogin: null,
  githubId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

/** Deps fake recording calls; `verify` matches on the exact stored hash. */
function fakeDeps(row: UserRow | null, correctPassword = "right"): AuthorizeDeps & {
  lookups: string[];
  verified: Array<{ password: string; hash: string }>;
} {
  const lookups: string[] = [];
  const verified: Array<{ password: string; hash: string }> = [];
  return {
    lookups,
    verified,
    findUserByEmail: async (email) => {
      lookups.push(email);
      return row;
    },
    verify: (password, hash) => {
      verified.push({ password, hash });
      return hash === row?.passwordHash && password === correctPassword;
    },
  };
}

test("authorize: correct credentials → AuthUser with role", async () => {
  const deps = fakeDeps(OWNER_ROW);
  const user = await authorizeUser("owner@example.com", "right", deps);
  assert.deepEqual(user, { id: "u-1", email: "owner@example.com", name: "Owner", role: "OWNER" });
});

test("authorize: email is trimmed + lowercased before lookup", async () => {
  const deps = fakeDeps(OWNER_ROW);
  await authorizeUser("  OWNER@Example.COM ", "right", deps);
  assert.deepEqual(deps.lookups, ["owner@example.com"]);
});

test("authorize: wrong password → null", async () => {
  const deps = fakeDeps(OWNER_ROW);
  assert.equal(await authorizeUser("owner@example.com", "wrong", deps), null);
});

test("authorize: unknown email → null, but verify still runs against the timing equalizer", async () => {
  const deps = fakeDeps(null);
  assert.equal(await authorizeUser("nobody@example.com", "whatever", deps), null);
  assert.equal(deps.verified.length, 1);
  assert.equal(deps.verified[0]?.hash, TIMING_EQUALIZER_HASH);
});

test("authorize: row without a password hash → null via the equalizer path", async () => {
  const deps = fakeDeps({ ...OWNER_ROW, passwordHash: null });
  assert.equal(await authorizeUser("owner@example.com", "right", deps), null);
  assert.equal(deps.verified[0]?.hash, TIMING_EQUALIZER_HASH);
});

test("authorize: non-string / empty input fails closed without any lookup", async () => {
  for (const [email, password] of [
    [undefined, "pw"],
    [42, "pw"],
    ["owner@example.com", undefined],
    ["owner@example.com", ""],
    ["not-an-email", "pw"],
  ] as const) {
    const deps = fakeDeps(OWNER_ROW);
    assert.equal(await authorizeUser(email, password, deps), null);
    assert.equal(deps.lookups.length, 0, `lookup ran for ${String(email)}/${String(password)}`);
  }
});

test("normalizeEmail: strings only, must contain @", () => {
  assert.equal(normalizeEmail(" A@B.co "), "a@b.co");
  assert.equal(normalizeEmail("nope"), null);
  assert.equal(normalizeEmail(123), null);
  assert.equal(normalizeEmail(null), null);
});

test("tokenWithUser: stamps role + uid at sign-in, passthrough on refresh", () => {
  const signIn = tokenWithUser({ sub: "s" }, { id: "u-1", role: "OWNER" });
  assert.equal(signIn.role, "OWNER");
  assert.equal(signIn.uid, "u-1");
  const refresh = tokenWithUser({ sub: "s", role: "OWNER" as const }, undefined);
  assert.deepEqual(refresh, { sub: "s", role: "OWNER" });
});

test("sessionRoleFromToken: known roles pass, anything else degrades to VIEWER", () => {
  assert.equal(sessionRoleFromToken("OWNER"), "OWNER");
  assert.equal(sessionRoleFromToken("MEMBER"), "MEMBER");
  assert.equal(sessionRoleFromToken("VIEWER"), "VIEWER");
  for (const bad of [undefined, null, "owner", "ADMIN", 1, {}]) {
    assert.equal(sessionRoleFromToken(bad), "VIEWER", `expected VIEWER for ${String(bad)}`);
  }
});

test("round-trip with the REAL scrypt verify (integration of 0072 + 0073)", async () => {
  const { hashPassword, verifyPassword } = await import("@launchpad/db");
  const row: UserRow = { ...OWNER_ROW, passwordHash: hashPassword("hunter2hunter2") };
  const deps: AuthorizeDeps = {
    findUserByEmail: async () => row,
    verify: verifyPassword,
  };
  const user = await authorizeUser("owner@example.com", "hunter2hunter2", deps);
  assert.equal(user?.role, "OWNER");
  assert.equal(await authorizeUser("owner@example.com", "hunter2hunter3", deps), null);
});

// ---------------------------------------------------------------------------
// The regression behind "your session is VIEWER" for an account that IS the
// OWNER (spec 0128 B, found by the 0129 D live test).
//
// Credentials' `authorize` returned a user carrying the DB row's role, so
// tokenWithUser had something to stamp. An OAuth profile carries no `role`, the
// claim went missing, and sessionRoleFromToken degraded the session to VIEWER —
// correctly, per least privilege, which is exactly why nothing crashed and the
// OWNER simply could not act.
// ---------------------------------------------------------------------------

test("a user with NO role produces no claim, and the session degrades to VIEWER", () => {
  const token = tokenWithUser({ sub: "x" }, { id: "u1" });
  assert.equal("role" in token, false, "nothing to stamp");
  assert.equal(sessionRoleFromToken((token as { role?: unknown }).role), "VIEWER");
});

test("the role must come from the DB row, and then it survives the round trip", () => {
  for (const role of ["OWNER", "MEMBER", "VIEWER"] as const) {
    const token = tokenWithUser({ sub: "x" }, { id: "u1", role });
    assert.equal(sessionRoleFromToken((token as { role?: unknown }).role), role, role);
  }
});
