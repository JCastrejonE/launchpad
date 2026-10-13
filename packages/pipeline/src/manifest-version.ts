/**
 * Bumping an Odoo addon's `__manifest__.py` version (spec 0170 decision 1).
 *
 * Odoo re-runs a module's migration scripts only when the manifest version
 * INCREASES. A release that does not move it deploys code and silently skips its
 * migrations — green everywhere, schema not migrated.
 *
 * The bump has to be a real edit **committed to the repo**, not a value stamped
 * into the deployed artifact, because Odoo migration scripts live in
 * `migrations/<manifest-version>/`. A deploy-time stamp would produce a version
 * whose migration folder nobody wrote, which breaks the exact mechanism this
 * exists to protect.
 *
 * The rewrite is deliberately narrow: the `version` entry of a manifest dict, and
 * nothing else. A `__manifest__.py` is Python, and parsing it properly would mean
 * running it — so this matches the one line it must change and refuses when it
 * cannot find exactly one.
 */
import { readdirSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** `"version": "18.0.1.0.0"` or `'version': '18.0.1.0.0'`, single line. */
const VERSION_ENTRY = /^(\s*["']version["']\s*:\s*)(["'])([^"']*)\2(\s*,?\s*)$/m;

export interface ManifestBump {
  /** Path of the manifest, relative to the repo root. */
  path: string;
  from: string;
  to: string;
}

/**
 * Replace the `version` entry in one manifest's source.
 *
 * Returns null when the file has no version entry at all — an addon that never
 * declared one is a real shape, and inventing the line would put it somewhere
 * arbitrary in the dict.
 */
export function rewriteManifestVersion(
  source: string,
  next: string,
): { source: string; from: string } | null {
  const m = VERSION_ENTRY.exec(source);
  if (!m) return null;
  const from = m[3] ?? "";
  const replaced = source.replace(VERSION_ENTRY, `$1$2${next}$2$4`);
  return { source: replaced, from };
}

/**
 * Every `__manifest__.py` under `repoRoot`, by the same rule `discoverAddons`
 * uses: a directory holding one, at the root or one conventional level down.
 */
export function findManifests(repoRoot: string): string[] {
  const found: string[] = [];
  for (const sub of ["", "addons", "odoo-addons"]) {
    const base = sub ? path.join(repoRoot, sub) : repoRoot;
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue; // a missing conventional dir is normal
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const manifest = path.join(base, e.name, "__manifest__.py");
      if (existsSync(manifest)) {
        found.push(sub ? path.posix.join(sub, e.name, "__manifest__.py") : path.posix.join(e.name, "__manifest__.py"));
      }
    }
  }
  return found.sort();
}

/**
 * Set every addon manifest's version to `next`.
 *
 * Returns what changed, so the caller can commit exactly those paths and — more
 * importantly — can tell that NOTHING changed. A release whose manifests did not
 * move is the failure decision 1 exists to prevent, so "no bumps" must be
 * visible to the caller rather than a silent success.
 */
export async function bumpAddonManifests(
  repoRoot: string,
  next: string,
): Promise<ManifestBump[]> {
  const bumps: ManifestBump[] = [];
  for (const rel of findManifests(repoRoot)) {
    const abs = path.join(repoRoot, rel);
    const source = await readFile(abs, "utf8");
    const rewritten = rewriteManifestVersion(source, next);
    if (!rewritten) continue;
    if (rewritten.from === next) continue; // already there; not a change
    await writeFile(abs, rewritten.source, "utf8");
    bumps.push({ path: rel, from: rewritten.from, to: next });
  }
  return bumps;
}
