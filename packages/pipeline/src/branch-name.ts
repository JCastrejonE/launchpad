/**
 * Branch-name validation (spec 0133) — one legal shape, validated, never
 * sanitised (the 0126 slug rule: silently rewriting what someone typed
 * produces a branch addressed by a name they did not choose).
 *
 * The shape is a deliberate STRICT SUBSET of git's ref rules, so anything
 * valid here is valid for git and `git check-ref-format` is never needed:
 *
 *  - lowercase alphanumerics plus `.` `_` `/` `-`, starting alphanumeric,
 *    at most 80 chars. Lowercase-only keeps 0134's DNS/compose sanitization
 *    sane (a DNS label cannot carry case, so two branches differing only by
 *    case would otherwise collide at the staging host).
 *  - no `..` (git path traversal), no `//` or trailing `/` (empty segment),
 *    no segment starting with `.`, no trailing `.` or `.lock` (git refuses
 *    them).
 *  - reserved: `main`, `master`, `HEAD` (case-insensitively) — the promote
 *    TARGET must never be creatable as a work branch — and the `spec/`
 *    prefix, which belongs to the platform's per-spec runs.
 */

const SHAPE = /^[a-z0-9][a-z0-9._/-]{0,79}$/;
const RESERVED = new Set(["main", "master", "head"]);

export function isValidBranchName(name: string): boolean {
  if (!SHAPE.test(name)) return false;
  if (name.includes("..") || name.includes("//")) return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  // No segment may start with "." — git refuses hidden path components.
  if (name.split("/").some((segment) => segment.startsWith("."))) return false;
  if (RESERVED.has(name.toLowerCase())) return false;
  if (name === "spec" || name.startsWith("spec/")) return false;
  return true;
}
