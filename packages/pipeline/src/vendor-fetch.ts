/**
 * Fetching the vendored addons onto the worker, ready to ship (spec 0206 B).
 *
 * `vendored-addons.ts` says WHICH addons and at which commit; this puts their
 * files in one staging directory and hands back the base64 `tar.gz` that
 * `DeployOptions.addonsArchive` already knows how to unpack into the tenant's
 * `/mnt/extra-addons`.
 *
 * THE RENAME IS THE POINT. Every addon lands as `<staging>/<module>` — its
 * technical name — regardless of what its repository or its subdirectory is
 * called. `odoo19enterprisemenu` becomes `app_menu_enterprise`, because that
 * addon's asset paths hardcode `app_menu_enterprise/static/src/...` and under
 * any other directory name it installs cleanly and does visibly nothing. That
 * failure has no error message, which is why the test asserts the placement
 * rather than the archive.
 *
 * Auth: a plain `https://github.com/...` clone, the same URL shape
 * `provisionRepoCheckout` uses. The worker user's `credential.helper=store`
 * supplies the token, so no secret passes through this code or its logs.
 */
import { mkdtemp, rm, mkdir, cp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { packAddonsWithTar, type PackAddons } from "@launchpad/fleet-hostinger";
import { run } from "./git.js";
import type { VendoredAddon } from "./vendored-addons.js";

/** Injectable I/O, so a test can exercise the placement without a network. The
 *  defaults are a real clone and the real tar. */
export interface VendorFetchDeps {
  /** Clone `example-org/<repo>` into `dest` and check out exactly `commit`. */
  cloneAt: (repo: string, commit: string, dest: string) => Promise<void>;
  pack: PackAddons;
}

export const defaultVendorFetchDeps: VendorFetchDeps = {
  cloneAt: async (repo, commit, dest) => {
    const url = `https://github.com/example-org/${repo}.git`;
    const cloned = await run("git", ["clone", url, dest], path.dirname(dest));
    if (!cloned.ok) throw new Error(`vendor fetch: clone of ${repo} failed: ${cloned.out.slice(0, 300)}`);
    // A full clone then a checkout, deliberately: `--depth 1` cannot reach an
    // arbitrary older commit, and these addon repos are small.
    const at = await run("git", ["checkout", "--detach", commit], dest);
    if (!at.ok) {
      throw new Error(`vendor fetch: ${repo} has no commit ${commit.slice(0, 9)}: ${at.out.slice(0, 300)}`);
    }
  },
  pack: packAddonsWithTar,
};

/**
 * Stage `addons` under their technical names and pack them.
 *
 * Returns `""` for an empty list — the same "nothing to ship" value
 * `packAddonsWithTar` returns, so the caller can pass it straight through.
 */
export async function fetchVendoredAddons(
  addons: readonly VendoredAddon[],
  deps: VendorFetchDeps = defaultVendorFetchDeps,
): Promise<string> {
  if (addons.length === 0) return "";

  const staging = await mkdtemp(path.join(tmpdir(), "vendored-addons-"));
  const clones: string[] = [];
  try {
    for (const addon of addons) {
      const clone = await mkdtemp(path.join(tmpdir(), `vendor-${addon.repo}-`));
      clones.push(clone);
      await deps.cloneAt(addon.repo, addon.commit, clone);
      // `subpath` empty means the manifest is at the repo root.
      const source = addon.subpath ? path.join(clone, addon.subpath) : clone;
      const dest = path.join(staging, addon.module);
      await mkdir(path.dirname(dest), { recursive: true });
      // `.git` would otherwise ride along into the tenant's addons mount for any
      // addon whose manifest is at the repo root.
      await cp(source, dest, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
      // 0755, because `mkdtemp` creates the clone at 0700 and `cp` carries that
      // mode onto a root-manifest addon (its source IS the clone directory).
      // tar stores the mode, so the addon lands 0700 in the tenant's mount and
      // Odoo — which runs as a non-root user — cannot traverse it. Measured on
      // ferreteria-delta: `app_menu_enterprise` was 0700 while the two addons
      // copied from a SUBPATH were 0755, so it was the only one Odoo never saw.
      // No error anywhere: the module simply had no `ir_module_module` row.
      await chmod(dest, 0o755);
    }
    return await deps.pack(
      staging,
      addons.map((a) => a.module),
    );
  } finally {
    for (const dir of [...clones, staging]) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
