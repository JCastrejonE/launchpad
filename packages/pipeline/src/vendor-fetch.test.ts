/**
 * Spec 0206 B. The failure under test is not "the archive is malformed" — tar
 * works. It is an addon placed under the wrong directory name, which installs
 * cleanly, emits no error, and does nothing. So these assert PLACEMENT.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { fetchVendoredAddons, type VendorFetchDeps } from "./vendor-fetch.js";
import type { VendoredAddon } from "./vendored-addons.js";

/** The real registry's shape, with the two placements that matter: an addon in a
 *  subdirectory, and one whose manifest is at the repo root under a repo name
 *  that is NOT the module name. */
const AT_SUBPATH: VendoredAddon = {
  module: "web_responsive",
  repo: "client-i-odoo",
  subpath: "addons-ext/web_responsive",
  commit: "a".repeat(40),
  series: 19,
  licence: "LGPL-3",
};
const AT_ROOT: VendoredAddon = {
  module: "app_menu_enterprise",
  repo: "odoo19enterprisemenu",
  subpath: "",
  commit: "b".repeat(40),
  series: 19,
  licence: "LGPL-3",
};

/** A fake clone that writes the tree the real repo has, so the placement logic
 *  is what runs. `pack` records what it was handed and leaves the staging tree
 *  on disk for the assertions. */
function fakeDeps(): { deps: VendorFetchDeps; packed: { root: string; paths: string[] }[] } {
  const packed: { root: string; paths: string[] }[] = [];
  const deps: VendorFetchDeps = {
    cloneAt: async (repo, _commit, dest) => {
      // Both repos carry a manifest and a static asset; only the depth differs.
      const inner = repo === "client-i-odoo" ? path.join(dest, "addons-ext", "web_responsive") : dest;
      await mkdir(path.join(inner, "static", "src"), { recursive: true });
      await writeFile(path.join(inner, "__manifest__.py"), `{"name": "${repo}"}`);
      await writeFile(path.join(inner, "static", "src", "app.js"), "// asset");
      await mkdir(path.join(dest, ".git"), { recursive: true });
      await writeFile(path.join(dest, ".git", "HEAD"), "ref: refs/heads/main");
    },
    pack: async (root, paths) => {
      packed.push({ root, paths: [...paths] });
      // Assertions run against the staging tree before the finally block clears
      // it, so read what matters here.
      return "ARCHIVE";
    },
  };
  return { deps, packed };
}

test("an addon is staged under its MODULE name, never its repo name", async () => {
  const { deps, packed } = fakeDeps();
  let staged: string[] = [];
  const spy: VendorFetchDeps = {
    ...deps,
    pack: async (root, paths) => {
      staged = (await readdir(root)).sort();
      return deps.pack(root, paths);
    },
  };
  const archive = await fetchVendoredAddons([AT_SUBPATH, AT_ROOT], spy);

  assert.equal(archive, "ARCHIVE");
  assert.deepEqual(staged, ["app_menu_enterprise", "web_responsive"]);
  assert.ok(
    !staged.includes("odoo19enterprisemenu"),
    "the repo name must never reach the addons mount — its assets would not load",
  );
  assert.deepEqual(packed[0]!.paths, ["web_responsive", "app_menu_enterprise"]);
});

test("a root-manifest addon is staged from the repo root, with its assets", async () => {
  const { deps } = fakeDeps();
  interface Found {
    manifest: boolean;
    asset: boolean;
    dotgit: boolean;
  }
  let found: Found | undefined;
  const spy: VendorFetchDeps = {
    ...deps,
    pack: async (root, paths) => {
      const at = path.join(root, "app_menu_enterprise");
      const exists = async (p: string) => !!(await stat(p).catch(() => null));
      found = {
        manifest: await exists(path.join(at, "__manifest__.py")),
        asset: await exists(path.join(at, "static", "src", "app.js")),
        dotgit: await exists(path.join(at, ".git")),
      };
      return deps.pack(root, paths);
    },
  };
  await fetchVendoredAddons([AT_ROOT], spy);

  assert.ok(found, "pack was never called");
  assert.equal(found!.manifest, true, "the manifest must land at the module root");
  assert.equal(found!.asset, true, "assets must come with it or the module loads nothing");
  assert.equal(found!.dotgit, false, "a .git directory must not ride into the addons mount");
});

test("a staged addon is traversable by a non-root Odoo", async () => {
  // Found live on ferreteria-delta. `mkdtemp` makes the clone 0700, and a
  // root-manifest addon is copied FROM that directory, so `cp` carries 0700 into
  // the tenant's addons mount. Odoo runs as a non-root user, could not traverse
  // it, and simply never created an `ir_module_module` row — no error anywhere.
  const { deps } = fakeDeps();
  let modes: Record<string, number> = {};
  const spy: VendorFetchDeps = {
    ...deps,
    pack: async (root, paths) => {
      for (const p of paths) modes[p] = (await stat(path.join(root, p))).mode & 0o777;
      return deps.pack(root, paths);
    },
  };
  await fetchVendoredAddons([AT_ROOT, AT_SUBPATH], spy);
  for (const [module, mode] of Object.entries(modes)) {
    assert.equal(
      mode & 0o055,
      0o055,
      `${module} is ${mode.toString(8)} — group/other cannot enter it, so Odoo will not see the module`,
    );
  }
});

test("nothing to vendor is an empty archive, not an empty tar", async () => {
  const { deps, packed } = fakeDeps();
  assert.equal(await fetchVendoredAddons([], deps), "");
  assert.equal(packed.length, 0, "no addons means no pack call at all");
});

test("a clone failure surfaces by name rather than shipping a partial archive", async () => {
  const { deps } = fakeDeps();
  const failing: VendorFetchDeps = {
    ...deps,
    cloneAt: async (repo) => {
      throw new Error(`clone of ${repo} failed`);
    },
  };
  await assert.rejects(() => fetchVendoredAddons([AT_ROOT], failing), /odoo19enterprisemenu/);
});
