/**
 * Branding-logo upload constraints (spec 0148 E2a) — deliberately in its own
 * module with ZERO imports, the same reason `slug.ts` is split out: `/new` is a
 * client component and needs this boundary check (spec 0161 E2b), but its old
 * home `project-create.ts` imports `@launchpad/db` — and therefore `pg` — which
 * `next build` cannot resolve in a browser bundle. A module boundary is the fix.
 */

/**
 * An allowlist of raster + SVG formats a logo is actually delivered in, and a
 * size ceiling — this is a logo committed to the front repo, not an asset store.
 */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const LOGO_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
];

/** Just enough of a browser `File` to check it, so the rule is unit-testable off the DOM. */
export interface LogoUpload {
  type: string;
  size: number;
}

/** One field, so the result carries only a human-readable reason, not a field name. */
export type LogoValidation = { ok: true } | { ok: false; problem: string };

/**
 * Refuse a non-image or oversized upload at the boundary (spec 0148 E2a), before
 * the bytes are ever carried into provisioning. Pure. An empty file is refused
 * too — it is not a logo.
 */
export function validateLogoUpload(file: LogoUpload): LogoValidation {
  if (!LOGO_MIME_TYPES.includes(file.type)) {
    return { ok: false, problem: "El logo debe ser una imagen PNG, JPG, SVG o WebP." };
  }
  if (file.size <= 0) {
    return { ok: false, problem: "El archivo del logo está vacío." };
  }
  if (file.size > LOGO_MAX_BYTES) {
    return { ok: false, problem: "El logo supera el tamaño máximo (2 MB)." };
  }
  return { ok: true };
}

/** File extension → MIME, the inverse of `/new`'s LOGO_EXT map — so the same
 * allowlist decides the type of a `LogoCommit` that no longer carries the
 * browser File's MIME (spec 0161 E2b: a LogoCommit is `{path, contentBase64}`). */
const LOGO_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  webp: "image/webp",
};

/** Decoded byte length of standard (newline-free) base64 — the shape
 * `FileReader.readAsDataURL` produces. Pure and Node-free (no `Buffer`) so this
 * module keeps its zero imports and stays safe in the `/new` client bundle. */
function base64ByteLength(b64: string): number {
  if (b64.length === 0) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor(b64.length / 4) * 3 - padding;
}

/**
 * Re-validate a base64 `LogoCommit` at the SERVER trust boundary (spec 0161):
 * the wizard's client-side `validateLogoUpload` is a convenience a forged
 * payload skips, so the start action must check again before the bytes become a
 * commit (VERIFICATION #1). Derives the type from the committed path's extension
 * and the size from the decoded base64, then reuses the one rule above.
 */
export function validateLogoCommit(logo: { path: string; contentBase64: string }): LogoValidation {
  const ext = logo.path.split(".").pop()?.toLowerCase() ?? "";
  const type = LOGO_EXT_TO_MIME[ext] ?? "";
  return validateLogoUpload({ type, size: base64ByteLength(logo.contentBase64) });
}
