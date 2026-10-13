import test from "node:test";
import assert from "node:assert/strict";
import {
  LOGO_MAX_BYTES,
  parseRepoRef,
  suggestSlug,
  validateLogoCommit,
  validateLogoUpload,
  validateProjectInput,
} from "./project-create";
// Same source the picker reads (spec 0205) — asserting against a copy would let
// the two drift and still pass.
import { DEFAULT_ODOO_VERSION, SUPPORTED_ODOO_VERSIONS } from "@launchpad/pipeline/procesos-modules";

/** A base64 string that decodes to exactly `bytes` bytes — so a size assertion
 * exercises the real decoded length, not the base64 char count. */
function b64OfBytes(bytes: number): string {
  return Buffer.alloc(bytes, 0x61).toString("base64");
}

const base = { name: "Distribuidora Client-C", slug: "client-c", kind: "odoo", client: "Client-C" };

test("a complete input validates and normalises", () => {
  const res = validateProjectInput({
    ...base,
    repo: "example-org/launchpad",
    productionKind: "odoosh",
    productionHost: "client@example.com",
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.repoOwner, "example-org");
  assert.equal(res.value.repoName, "launchpad");
  assert.equal(res.value.productionKind, "odoosh");
  assert.equal(res.value.client, "Client-C");
});

test("no repo and no production target is legitimate — most projects start there", () => {
  const res = validateProjectInput(base);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.repoOwner, null);
  assert.equal(res.value.productionKind, "none");
  assert.equal(res.value.productionHost, null);
});

// ── spec 0205 A1: the version is a recorded answer, never an inference ───────

test("the picked version is carried through, not the default", () => {
  const res = validateProjectInput({ ...base, odooVersion: "18" });
  assert.equal(res.ok && res.value.odooVersion, 18);
});

test("an Odoo project always leaves here with a version, never blank", () => {
  // The failure this guards: `projects.version` stays "" and provisioning's
  // fallback silently means 18 forever, whatever the customer needed.
  for (const kind of ["odoo", "odoo_next"]) {
    const res = validateProjectInput({ ...base, kind });
    assert.equal(res.ok && res.value.odooVersion, DEFAULT_ODOO_VERSION, kind);
  }
});

test("a custom project gets no version — it runs no Odoo", () => {
  const res = validateProjectInput({ ...base, kind: "custom", odooVersion: "19" });
  assert.equal(res.ok && res.value.odooVersion, null);
});

test("a version we have not verified is refused by field, not rounded down", () => {
  // 17 renders (the compose template is parameterised) and has never been
  // checked against an image. Accepting it would provision a promise.
  const res = validateProjectInput({ ...base, odooVersion: "17" });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.field, "odooVersion");
  assert.equal(validateProjectInput({ ...base, odooVersion: "banana" }).ok, false);
});

test("every version the wizard can offer is one the validator accepts", () => {
  // The picker maps over SUPPORTED_ODOO_VERSIONS. An option the validator
  // refuses is a button that cannot work.
  for (const v of SUPPORTED_ODOO_VERSIONS) {
    assert.equal(validateProjectInput({ ...base, odooVersion: String(v) }).ok, true, `Odoo ${v}`);
  }
});

test("client defaults to the project name rather than being required twice", () => {
  const res = validateProjectInput({ ...base, client: "  " });
  assert.equal(res.ok && res.value.client, "Distribuidora Client-C");
});

// Each rejection names the FIELD, so the wizard can point at the wrong input
// instead of showing a generic failure.
test("an invalid slug is refused, naming the field", () => {
  for (const slug of ["Client-C", "-x", "a", "x".repeat(41), "acme/prod", "../etc"]) {
    const res = validateProjectInput({ ...base, slug });
    assert.equal(res.ok, false, slug);
    if (!res.ok) assert.equal(res.field, "slug", slug);
  }
});

test("an unknown kind or production target is refused", () => {
  const k = validateProjectInput({ ...base, kind: "wordpress" });
  assert.equal(k.ok, false);
  if (!k.ok) assert.equal(k.field, "kind");
  const p = validateProjectInput({ ...base, productionKind: "heroku" });
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.field, "productionKind");
});

test("a name shorter than 2 chars is refused", () => {
  const res = validateProjectInput({ ...base, name: "F" });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.field, "name");
});

// An SSH host only means something for odoo.sh; on the fleet the address is the
// VPS. Storing it anyway would be a fact nothing reads.
test("a production host is refused on a target that cannot use one", () => {
  const res = validateProjectInput({ ...base, productionKind: "fleet", productionHost: "root@203.0.113.40" });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.field, "productionHost");
});

test("parseRepoRef accepts owner/repo and the URLs people actually paste", () => {
  for (const raw of [
    "example-org/launchpad",
    "  example-org/launchpad  ",
    "https://github.com/example-org/launchpad",
    "https://github.com/example-org/launchpad.git",
    "https://github.com/example-org/launchpad/",
    "git@github.com:example-org/launchpad.git",
  ]) {
    const res = parseRepoRef(raw);
    assert.equal(res.ok, true, raw);
    if (res.ok) {
      assert.equal(res.owner, "example-org", raw);
      assert.equal(res.name, "launchpad", raw);
    }
  }
});

// The failure mode this prevents: a pasted URL split into an owner called
// "https:" and a repo called "" — stored happily, then 404 at gate 2.
test("parseRepoRef refuses anything that is not exactly two segments", () => {
  for (const raw of ["launchpad", "a/b/c", "", "   ", "/", "owner/", "/repo"]) {
    assert.equal(parseRepoRef(raw).ok, false, JSON.stringify(raw));
  }
});

test("parseRepoRef refuses characters GitHub does not allow", () => {
  for (const raw of ["own er/repo", "owner/re po", "owner/-repo?x", "ow;ner/repo"]) {
    assert.equal(parseRepoRef(raw).ok, false, raw);
  }
});

// A SUGGESTION for prefilling the form. It never rewrites what someone typed —
// createProject still refuses an invalid slug.
test("suggestSlug produces something valid from a real name", () => {
  assert.equal(suggestSlug("Distribuidora Client-C"), "distribuidora-client-c");
  assert.equal(suggestSlug("Ferretería Sánchez, S.A. de C.V."), "ferreteria-sanchez-s-a-de-c-v");
  assert.equal(suggestSlug("  ACME  "), "acme");
  assert.equal(suggestSlug("x".repeat(60)).length <= 40, true);
  // No leading/trailing hyphen, which is what makes the result a legal slug.
  assert.equal(/^[a-z0-9].*[a-z0-9]$/.test(suggestSlug("¡Hola! Mundo!!")), true);
});

// Spec 0137: all three clone-URL shapes GitHub itself offers normalise to the
// same owner/name — https, scp-style ssh, and URL-style ssh.
test("parseRepoRef accepts every GitHub clone-URL shape", () => {
  for (const raw of [
    "example-org/abtest-odoo",
    "https://github.com/example-org/abtest-odoo",
    "https://github.com/example-org/abtest-odoo.git",
    "git@github.com:example-org/abtest-odoo.git",
    "ssh://git@github.com/example-org/abtest-odoo.git",
    "ssh://git@github.com/example-org/abtest-odoo",
  ]) {
    const parsed = parseRepoRef(raw);
    assert.equal(parsed.ok, true, raw);
    if (parsed.ok) {
      assert.equal(parsed.owner, "example-org");
      assert.equal(parsed.name, "abtest-odoo");
    }
  }
});

test("parseRepoRef still refuses a non-GitHub ssh host rather than mangling it", () => {
  const parsed = parseRepoRef("ssh://git@gitlab.com/owner/repo.git");
  assert.equal(parsed.ok, false);
});

// Spec 0148 E — the branding-logo boundary check. A real image within the
// ceiling passes; every other case is refused before the bytes reach provisioning.
test("validateLogoUpload accepts each allowed image format within the size ceiling", () => {
  for (const type of ["image/png", "image/jpeg", "image/svg+xml", "image/webp"]) {
    assert.equal(validateLogoUpload({ type, size: 4096 }).ok, true, type);
  }
});

test("validateLogoUpload refuses a non-image at the boundary", () => {
  const res = validateLogoUpload({ type: "application/pdf", size: 4096 });
  assert.equal(res.ok, false);
});

test("validateLogoUpload refuses an oversized upload at the boundary", () => {
  const res = validateLogoUpload({ type: "image/png", size: LOGO_MAX_BYTES + 1 });
  assert.equal(res.ok, false);
  // The check can actually fail the other way (VERIFICATION #2): exactly at the
  // ceiling still passes, so the comparison is a real boundary, not always-reject.
  assert.equal(validateLogoUpload({ type: "image/png", size: LOGO_MAX_BYTES }).ok, true);
});

test("validateLogoUpload refuses an empty file — it is not a logo", () => {
  assert.equal(validateLogoUpload({ type: "image/png", size: 0 }).ok, false);
});

// Spec 0161: the SERVER re-check of a base64 LogoCommit, whose payload has no
// browser MIME/size to trust (VERIFICATION #1). Type comes from the path's
// extension, size from the decoded base64.
test("validateLogoCommit accepts a real image within the ceiling", () => {
  assert.equal(validateLogoCommit({ path: "public/logo.png", contentBase64: b64OfBytes(4096) }).ok, true);
  assert.equal(validateLogoCommit({ path: "public/logo.svg", contentBase64: b64OfBytes(64) }).ok, true);
});

test("validateLogoCommit refuses a forged non-image extension", () => {
  const res = validateLogoCommit({ path: "public/logo.exe", contentBase64: b64OfBytes(4096) });
  assert.equal(res.ok, false);
});

test("validateLogoCommit refuses an oversized payload by DECODED length", () => {
  assert.equal(validateLogoCommit({ path: "public/logo.png", contentBase64: b64OfBytes(LOGO_MAX_BYTES + 1) }).ok, false);
  // The boundary can fail the other way too (VERIFICATION #2): exactly the
  // ceiling still passes, so the decoded-length math is a real limit.
  assert.equal(validateLogoCommit({ path: "public/logo.png", contentBase64: b64OfBytes(LOGO_MAX_BYTES) }).ok, true);
});

test("validateLogoCommit refuses an empty payload", () => {
  assert.equal(validateLogoCommit({ path: "public/logo.png", contentBase64: "" }).ok, false);
});
