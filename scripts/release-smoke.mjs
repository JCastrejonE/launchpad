#!/usr/bin/env node
/**
 * Release smoke (spec 0177) — does every project's production actually hold
 * what we say we shipped?
 *
 * Run it after a deploy of the launchpad, and after any release. It costs
 * seconds and no LLM spend: it drives nothing, it only measures.
 *
 *   node scripts/release-smoke.mjs             # every fleet project
 *   node scripts/release-smoke.mjs sushi       # one
 *
 * Exits non-zero when any project reports a problem, so it can gate a deploy.
 *
 * ## Why a script and not a test
 *
 * The two defects this exists for (0175, 0176) both passed every unit test we
 * had, on a deploy that reported success. What they could not pass is a
 * question asked of the customer's own systems: the hostname a person types,
 * and `ir_module_module` in the tenant's database. That needs real DNS, real
 * Traefik and real Postgres — so it is a script against live infrastructure,
 * and the DECISION it makes is a pure function with its own tests
 * (`release-smoke.ts`), fed the exact facts observed live.
 */
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

// Resolve the workspace packages the way every sibling script does: from each
// package's own manifest, to its BUILT dist. A bare specifier does not resolve
// from `scripts/`, which is its own package-less directory.
const dbRequire = createRequire(new URL("../packages/db/package.json", import.meta.url));
const pipelineRequire = createRequire(new URL("../packages/pipeline/package.json", import.meta.url));
const fleetRequire = createRequire(new URL("../packages/fleet-hostinger/package.json", import.meta.url));

/** `.env`-style file into process.env, without overwriting what is already set
 * (systemd's EnvironmentFile wins on the app host). Never printed. */
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z_0-9]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/** HTTP status, or null when the request could not be made at all. `null` is
 * NOT a pass — the verdict treats it as unreachable. */
async function statusOf(url) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    return res.status;
  } catch {
    return null;
  }
}

/** Run a command ON the sandbox VPS over the fleet identity. */
async function ssh(host, command) {
  const identity = process.env["LAUNCHPAD_FLEET_SSH_IDENTITY"];
  if (!identity) throw new Error("set LAUNCHPAD_FLEET_SSH_IDENTITY");
  const user = process.env["LAUNCHPAD_FLEET_SSH_USER"] ?? "root";
  const { stdout } = await exec("ssh", [
    "-i", identity, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    "-o", "StrictHostKeyChecking=accept-new",
    `${user}@${host}`, command,
  ], { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function main() {
  loadEnvFile("/etc/launchpad/launchpad.env");
  loadEnvFile(path.join(ROOT, ".env"));

  const { createDb, createPool, listProjects, deployedRelease } = await import(
    dbRequire.resolve("./dist/index.js")
  );
  const { releaseSmokeProblems } = await import(pipelineRequire.resolve("./dist/index.js"));
  const { tenantDbName, composeProjectName } = await import(
    fleetRequire.resolve("./dist/index.js")
  );

  const only = process.argv[2];
  const pool = createPool();
  const db = createDb(pool);
  let failed = 0;
  let checked = 0;

  try {
    const projects = (await listProjects(db)).filter(
      (p) => p.productionKind === "fleet" && (!only || p.slug === only),
    );
    if (projects.length === 0) {
      console.log("release-smoke: no fleet projects to check");
      return;
    }

    // One SSH host for the whole sweep: every fleet project lives on the sandbox
    // VPS today, and its address comes from the same env the worker uses.
    const vpsIp = process.env["LAUNCHPAD_SMOKE_VPS_IP"] ?? "203.0.113.20";

    for (const project of projects) {
      const release = await deployedRelease(db, project.id);
      const domain = project.domain ?? "example.com";
      // The hostname convention follows the project's KIND. An odoo-next project
      // was provisioned at `<slug>.odoo.<domain>` with a front at
      // `<slug>.<domain>`; a plain `odoo` tenant lives at `prod.<slug>.<domain>`
      // and has no front at all. The first live run reported `ab-test-sandbox`
      // for lacking a front it never had — a check that cries wolf about
      // absent features teaches people to ignore it.
      const hasFront = project.kind === "odoo_next";
      const facts = {
        slug: project.slug,
        odooHost: hasFront ? `${project.slug}.odoo.${domain}` : `prod.${project.slug}.${domain}`,
        frontHost: `${project.slug}.${domain}`,
        odooStatus: null,
        frontStatus: null,
        releaseVersion: release?.version ?? null,
        // When the CODE existed, not when the deploy row was written: the front
        // is deployed seconds BEFORE the row is marked deployed.
        releaseCreatedAt: release?.createdAt ? new Date(release.createdAt) : null,
        odooSeries: Number((project.version ?? "18").split(".")[0]) || 18,
        expectedModules: [],
        hasFront,
        modules: [],
        frontStartedAt: null,
        // Filled below, once we know the container names. A project with no
        // release never reaches that code and is never judged either.
        restartPolicies: [],
      };

      if (!facts.releaseVersion) {
        console.log(`· ${project.slug}: sin release desplegada — nada que verificar`);
        continue;
      }
      checked += 1;

      [facts.odooStatus, facts.frontStatus] = await Promise.all([
        statusOf(`https://${facts.odooHost}/web/login`),
        hasFront ? statusOf(`https://${facts.frontHost}/`) : Promise.resolve(null),
      ]);

      // What SHOULD be installed: the addons in the RELEASE's tree, read from
      // the project's own checkout at that commit — the repo is the source of
      // truth here, never the box we are auditing.
      if (project.repoRoot && existsSync(project.repoRoot)) {
        const { stdout } = await exec(
          "git",
          ["ls-tree", "-r", "--name-only", release.commitSha],
          { cwd: project.repoRoot, maxBuffer: 8 * 1024 * 1024 },
        ).catch(() => ({ stdout: "" }));
        facts.expectedModules = stdout
          .split("\n")
          .filter((f) => f.endsWith("__manifest__.py"))
          .map((f) => path.basename(path.dirname(f)))
          .filter((name, i, all) => all.indexOf(name) === i);
      }

      // What IS installed: the tenant's own database.
      const dbName = tenantDbName(project.slug, "prod");
      const dbContainer = `${composeProjectName(project.slug, "prod")}-db-1`;
      const frontContainer = `${composeProjectName(project.slug, "front")}-front-1`;

      // Does this tenant come back by itself after a docker daemon restart?
      // (spec 0215) The template declaring the policy proves nothing: Docker
      // fixes `HostConfig.RestartPolicy` when the container is CREATED, so only
      // the running container can answer.
      const containers = [
        `${composeProjectName(project.slug, "prod")}-odoo-1`,
        dbContainer,
        ...(hasFront ? [frontContainer] : []),
      ];
      let measured = new Map();
      try {
        // `|| true`: docker inspect exits non-zero if ANY name is missing, which
        // would throw away the lines it did print for the others.
        const out = await ssh(
          vpsIp,
          `docker inspect ${containers.join(" ")} ` +
            `--format '{{.Name}} {{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || true`,
        );
        measured = new Map(
          out
            .split("\n")
            .map((l) => l.trim().split(/\s+/))
            .filter(([name, policy]) => name && policy)
            .map(([name, policy]) => [name.replace(/^\//, ""), policy]),
        );
      } catch (err) {
        console.error(`  ! ${project.slug}: no pude inspeccionar restart policies — ${err.message}`);
      }
      // A container the inspect never answered for stays `null` — unmeasured is
      // a problem in the verdict, not a pass.
      facts.restartPolicies = containers.map((container) => ({
        container,
        policy: measured.get(container) ?? null,
      }));

      try {
        const rows = await ssh(
          vpsIp,
          `docker exec ${dbContainer} psql -U odoo -d ${dbName} -t -A -F'|' ` +
            `-c "select name, state, latest_version from ir_module_module"`,
        );
        facts.modules = rows
          .split("\n")
          .map((l) => l.trim().split("|"))
          .filter((p) => p.length >= 3 && p[0])
          .map(([name, state, version]) => ({ name, state, version }));
      } catch (err) {
        console.error(`  ! ${project.slug}: no pude leer ir_module_module — ${err.message}`);
      }
      if (hasFront) try {
        const started = await ssh(
          vpsIp,
          `docker inspect ${frontContainer} --format '{{.State.StartedAt}}' 2>/dev/null || true`,
        );
        const t = started.trim();
        if (t) facts.frontStartedAt = new Date(t);
      } catch {
        // A project with no front is normal (plain odoo); the verdict skips it.
      }

      const problems = releaseSmokeProblems(facts);
      if (problems.length === 0) {
        console.log(
          `✓ ${project.slug} ${facts.releaseVersion}: ${facts.odooHost} 200` +
            `${hasFront ? ` · ${facts.frontHost} 200` : " · sin front"} · ` +
            `${facts.expectedModules.length} addon(s) instalados`,
        );
        continue;
      }
      failed += 1;
      console.error(`✗ ${project.slug} ${facts.releaseVersion}:`);
      for (const p of problems) console.error(`    [${p.code}] ${p.detail}`);
    }
  } finally {
    await pool.end();
  }

  console.log(`release-smoke: ${checked} proyecto(s) con release, ${failed} con problemas`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("release-smoke:", err?.message ?? err);
  process.exitCode = 1;
});
