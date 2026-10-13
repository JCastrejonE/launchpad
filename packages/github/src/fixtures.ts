/**
 * Contract-test fixture loader (spec 0015), mirroring the Hostinger client's
 * loader. Fixtures are checked-in JSON under `packages/github/fixtures/`,
 * hand-authored against the current GitHub REST docs and clearly marked as
 * fixtures — CI NEVER calls the live GitHub API, and no fixture contains the
 * token. Resolves relative to the compiled `dist/` location so
 * `node --test dist/*.test.js` finds them.
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
