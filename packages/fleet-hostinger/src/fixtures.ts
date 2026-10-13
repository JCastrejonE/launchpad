/**
 * Contract-test fixture loader (spec 0011). Fixtures are checked-in JSON under
 * `packages/fleet-hostinger/fixtures/`, hand-verified against the live
 * Hostinger VPS API docs (developers.hostinger.com) and clearly marked as
 * fixtures — CI NEVER calls the live API. This helper resolves them relative
 * to the compiled `dist/` location so `node --test dist/*.test.js` finds them.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// dist/fixtures.js -> ../fixtures  (package-root/fixtures)
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** Reads and parses `fixtures/<name>.json`. */
export async function loadFixture<T = unknown>(name: string): Promise<T> {
  const raw = await readFile(path.join(FIXTURE_DIR, `${name}.json`), "utf8");
  return JSON.parse(raw) as T;
}
