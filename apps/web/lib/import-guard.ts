/**
 * Import-extension guard (spec 0020).
 *
 * Deterministic scanner for the defect class spec 0017 shipped green: a
 * relative import specifier that carries a source-file extension (e.g. a
 * `./y.js` specifier on an import-from statement). Under apps/web's Bundler
 * moduleResolution `tsc` rewrites `.js`->`.ts` and accepts it, so the
 * mandated gate passes; but
 * Next's webpack cannot resolve the specifier at build/runtime and every page
 * 500s. This scanner flags those specifiers so the rule is enforced at every
 * gate that runs apps/web's `test` script (see import-guard.test.ts).
 *
 * PURE by design — source text + filename in, violations out, NO fs (same
 * shape as spec-source.ts). The enforcement walk over the real repo tree
 * lives in the test file, which is allowed to touch disk; this module never is,
 * so it stays trivially unit-testable.
 */

/**
 * Source-file extensions that are illegal on a RELATIVE import specifier in a
 * bundled apps/web source. Package specifiers, `node:` builtins, and
 * extensionless relative imports are all fine — only these on a `./`/`../`
 * path are flagged. (`.json`/`.css`/asset extensions are intentionally NOT
 * here: those are legitimately imported with their extension.)
 */
export const GUARDED_IMPORT_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
] as const;

export type GuardedImportExtension = (typeof GUARDED_IMPORT_EXTENSIONS)[number];

/**
 * Trailing-comment marker that exempts a single import line from the guard.
 * A future legitimate case must carry this marker on the same line so it shows
 * up in the PR diff (visible, reviewable) rather than being silently unscanned.
 * e.g. `import x from "./legacy.js"; // import-guard-allow-ext: <reason>`
 */
export const IMPORT_GUARD_EXEMPT_MARKER = "import-guard-allow-ext";

/** One flagged relative import specifier. */
export interface ImportViolation {
  /** 1-based line number within `source`. */
  line: number;
  /** The offending relative specifier, e.g. "./specs.js". */
  specifier: string;
  /** The guarded extension that triggered the flag, e.g. ".js". */
  extension: GuardedImportExtension;
}

/**
 * True for files EXEMPT from the guard: `*.test.ts` sources compile to CJS for
 * `node --test` (tsconfig.test.json) and legitimately import `./x.js` (every
 * current `lib/*.test.ts` does). Accepts a bare basename or any path ending in
 * one.
 */
export function isGuardExemptFile(filename: string): boolean {
  return /\.test\.tsx?$/.test(filename);
}

/**
 * Matches, on a single line, the specifier string of:
 *  1. `import ... from "spec"` / `export ... from "spec"` (group 1)
 *  2. dynamic `import("spec")` (group 2)
 *  3. bare side-effect `import "spec"` (group 3)
 * Alternation order matters: form 1 is tried first so `import { x } from
 * "./y.js"` is captured whole rather than falling through to form 3.
 */
const IMPORT_SPECIFIER_RE =
  /\b(?:import|export)\b[^'"]*?\bfrom\s+["']([^'"]+)["']|\bimport\s*\(\s*["']([^'"]+)["']\s*\)|\bimport\s+["']([^'"]+)["']/g;

/**
 * Scan one bundled apps/web source for relative import specifiers carrying a
 * guarded source-file extension. Covers `import`/`export ... from` and
 * dynamic `import(...)` forms. Returns [] for exempt files
 * (`isGuardExemptFile`) and for lines carrying `IMPORT_GUARD_EXEMPT_MARKER`.
 */
export function scanImportExtensions(
  source: string,
  filename: string,
): ImportViolation[] {
  if (isGuardExemptFile(filename)) return [];

  const violations: ImportViolation[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(IMPORT_GUARD_EXEMPT_MARKER)) continue;

    for (const match of line.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;

      const extension = GUARDED_IMPORT_EXTENSIONS.find((ext) =>
        specifier.endsWith(ext),
      );
      if (!extension) continue;

      violations.push({ line: i + 1, specifier, extension });
    }
  }

  return violations;
}
