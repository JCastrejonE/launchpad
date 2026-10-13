import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerSeedValues, userSeedValues, type SeedRole } from "./seed-owner.js";

const HASH = "scrypt$131072$8$1$c2FsdHNhbHRzYWx0c2FsdA==$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5";

test("owner seed always carries role OWNER and normalized email", () => {
  const values = ownerSeedValues({ email: "  OWNER@Example.COM ", name: " Owner ", passwordHash: HASH });
  assert.equal(values.role, "OWNER");
  assert.equal(values.email, "owner@example.com");
  assert.equal(values.name, "Owner");
});

test("rejects an invalid email", () => {
  assert.throws(() => ownerSeedValues({ email: "not-an-email", name: "Owner", passwordHash: HASH }));
  assert.throws(() => ownerSeedValues({ email: "", name: "Owner", passwordHash: HASH }));
});

test("rejects an empty name", () => {
  assert.throws(() => ownerSeedValues({ email: "owner@example.com", name: "  ", passwordHash: HASH }));
});

test("rejects a plaintext-looking passwordHash (wiring-mistake guard)", () => {
  assert.throws(
    () => ownerSeedValues({ email: "owner@example.com", name: "Owner", passwordHash: "hunter2hunter2" }),
    /scrypt/,
  );
});

// --- spec 0117: seeding at any role ----------------------------------------

test("userSeedValues carries each role through unchanged", () => {
  for (const role of ["OWNER", "MEMBER", "VIEWER"] as SeedRole[]) {
    const values = userSeedValues({ email: "a@b.com", name: "A", passwordHash: HASH, role });
    assert.equal(values.role, role);
  }
});

test("a MEMBER seed does NOT silently become an OWNER", () => {
  // The failure this guards is a widening bug: generalizing ownerSeedValues by
  // adding a role parameter while leaving the hardcoded `role: "OWNER"` in the
  // returned object would pass every other test in this file.
  const values = userSeedValues({ email: "m@b.com", name: "M", passwordHash: HASH, role: "MEMBER" });
  assert.equal(values.role, "MEMBER");
  assert.notEqual(values.role, "OWNER");
});

test("rejects an unknown role rather than handing it to the pgEnum", () => {
  assert.throws(
    () =>
      userSeedValues({
        email: "a@b.com",
        name: "A",
        passwordHash: HASH,
        role: "ADMIN" as unknown as SeedRole,
      }),
    /OWNER, MEMBER, VIEWER/,
  );
});

test("every validation the owner seed had still applies at other roles", () => {
  const base = { name: "A", passwordHash: HASH, role: "VIEWER" as SeedRole };
  assert.throws(() => userSeedValues({ ...base, email: "not-an-email" }));
  assert.throws(() => userSeedValues({ ...base, email: "a@b.com", name: "  " }));
  assert.throws(() => userSeedValues({ ...base, email: "a@b.com", passwordHash: "hunter2hunter2" }), /scrypt/);
});
