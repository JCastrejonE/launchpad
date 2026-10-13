/**
 * Fleet-layer sandbox allowlist enforcement (spec 0014 / ADR-013). The allowlist
 * (`infra/fleet-sandbox.json`) is loaded by the FLEET PACKAGE ITSELF so that
 * every mutating operation — bootstrap steps, deploys, destructive Hostinger
 * client calls invoked via fleet helpers — refuses a non-allowlisted VPS id at
 * the LOWEST layer, not just in a smoke script's argument check.
 *
 * Boundary: only ids in `sandboxVpsIds` may be mutated without per-action human
 * confirmation. Every other id (notably 100002, production erp.example.com) is
 * hard-refused here. Agents never edit the allowlist file (human commits only).
 *
 * Wired into every mutating seam (spec 0014 plan step 2): `provisionClientVps`
 * (bootstrap.ts), `deployProductionStack` (stack.ts), and the destructive
 * Hostinger client helpers `restartVps`/`createSnapshot`/`attachSshKey`
 * (client.ts) — `getVps`/`listVps` stay unrestricted (read-only). Production
 * call sites never pass `path`; it exists so tests can point at a temp
 * allowlist file, or simply exercise the real allowlist via its own known ids
 * (100001 sandbox, 100002 production).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import { FleetError } from "./errors.js";

/** Env var overriding the default allowlist path (production never sets `path` explicitly). */
export const SANDBOX_ALLOWLIST_PATH_ENV = "LAUNCHPAD_FLEET_SANDBOX_PATH";

/** dist/sandbox.js -> repo-root/infra/fleet-sandbox.json */
export const DEFAULT_SANDBOX_ALLOWLIST_PATH = nodePath.join(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "infra",
  "fleet-sandbox.json",
);

/** Resolves the effective allowlist path: explicit arg, else env override, else the default. */
function resolveAllowlistPath(path?: string): string {
  if (path) return path;
  const override = process.env[SANDBOX_ALLOWLIST_PATH_ENV];
  return override && override.length > 0 ? override : DEFAULT_SANDBOX_ALLOWLIST_PATH;
}

interface SandboxAllowlistFile {
  sandboxVpsIds?: unknown;
}

/** Reads `sandboxVpsIds` from `infra/fleet-sandbox.json` (path overridable in tests). */
export function loadSandboxAllowlist(path?: string): number[] {
  const resolvedPath = resolveAllowlistPath(path);
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new FleetError(
      "config",
      `failed to read fleet sandbox allowlist at ${resolvedPath}`,
      { retryable: false, cause: err },
    );
  }

  let parsed: SandboxAllowlistFile;
  try {
    parsed = JSON.parse(raw) as SandboxAllowlistFile;
  } catch (err) {
    throw new FleetError(
      "config",
      `fleet sandbox allowlist at ${resolvedPath} is not valid JSON`,
      { retryable: false, cause: err },
    );
  }

  const ids = parsed.sandboxVpsIds;
  if (!Array.isArray(ids) || !ids.every((id): id is number => typeof id === "number")) {
    throw new FleetError(
      "config",
      `fleet sandbox allowlist at ${resolvedPath} must have a "sandboxVpsIds" array of numbers`,
      { retryable: false },
    );
  }
  return ids;
}

/** True iff `vpsId` is on the sandbox allowlist (safe to mutate without consent). */
export function isSandboxVps(vpsId: number, path?: string): boolean {
  return loadSandboxAllowlist(path).includes(vpsId);
}

/**
 * Throws a non-retryable `FleetError` (kind `sandbox`) naming `operation` and
 * `vpsId` unless `vpsId` is allowlisted. Called at the start of every mutating
 * fleet operation so a non-sandbox id is refused before any side effect.
 */
export function assertSandboxVps(vpsId: number, operation: string, path?: string): void {
  if (isSandboxVps(vpsId, path)) return;
  throw new FleetError(
    "sandbox",
    `refusing "${operation}" on VPS ${vpsId}: not on the fleet sandbox allowlist ` +
      `(infra/fleet-sandbox.json, ADR-013) — only sandbox VPS ids may be mutated by ` +
      `fleet tooling without per-action human confirmation`,
    { retryable: false },
  );
}
