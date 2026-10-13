#!/usr/bin/env node
/**
 * Backfill `restart: unless-stopped` on the tenant `-prod` containers that
 * already exist — spec 0215.
 *
 * Docker fixes `HostConfig.RestartPolicy` when a container is CREATED, so the
 * template fix (spec 0215 item 1) reaches future deploys only: every `-prod`
 * container running today still dies for good on the next `systemctl restart
 * docker`, exactly as on 2026-08-14. This is what closes that.
 *
 *   node scripts/fleet-restart-policy-backfill.mjs            # report only
 *   node scripts/fleet-restart-policy-backfill.mjs --apply    # `docker update`
 *
 * ## Mechanism: `docker update`, never compose
 *
 * `docker update --restart unless-stopped <id>` rewrites the HostConfig in
 * place: no recreate, no downtime, no volume touched. This script therefore
 * issues NO `docker compose` command at all — which is also why it cannot
 * repeat the accident of CLAUDE.md verification #14 corollary 2 (a bare
 * `docker compose up -d` in `/opt/launchpad/<slug>/prod` building a fresh,
 * empty-volume stack called `prod`), and never a `down -v`.
 *
 * It verifies its own end state (verification #2 and #8): after each update it
 * re-inspects the container and demands BOTH `unless-stopped` AND the same
 * container `Id` as before — the Id is the proof that nothing was recreated.
 *
 * ## Authorization (ADR-013)
 *
 * Targets come from `loadSandboxAllowlist()`. There is deliberately no
 * `--vps-id`: no argument to this script can point it at a VPS outside the
 * allowlist. `assertSandboxVps` is called again before any mutation, so the
 * refusal survives someone adding an argument later.
 *
 * Exit code: non-zero if any container could not be verified as
 * `unless-stopped` after an update, or if a box could not be read. Report mode
 * exits 0 even with pending containers — `release-smoke` is the red gate for
 * "a tenant is still exposed"; this script is the repair.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const fleetRequire = createRequire(new URL("../packages/fleet-hostinger/package.json", import.meta.url));

const APPLY = process.argv.includes("--apply");

const FLEET_SSH_IDENTITY_ENV = "LAUNCHPAD_FLEET_SSH_IDENTITY";
const FLEET_SSH_USER_ENV = "LAUNCHPAD_FLEET_SSH_USER";

/** The one policy this repo's 18 other services declare. `always` would revive
 * a container an operator stopped on purpose. */
const WANTED = "unless-stopped";

/**
 * Parses the inspect sweep's output into `{id, name, project, policy}` rows.
 * One line per container: `<Id> <Name> <compose project> <restart policy>`.
 *
 * Read from BOTH ENDS, never `parts.length === 4` (verification #11): a
 * container with no compose label prints Go's `<no value>`, which is TWO
 * tokens — a fixed-width parse drops those lines silently. Id, name and policy
 * cannot contain a space, so everything between them is the project.
 * `{{.Name}}` comes back with a leading slash.
 */
export function parseContainers(stdout) {
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .map((parts) => ({
      id: parts[0],
      name: parts[1].replace(/^\//, ""),
      project: parts.slice(2, -1).join(" "),
      policy: parts[parts.length - 1],
    }));
}

async function main() {
  const { loadSandboxAllowlist, assertSandboxVps, HostingerClient, ExecSshRunner, SHARED_TOKEN_ENV } =
    await import(fleetRequire.resolve("./dist/index.js"));

  const token = process.env[SHARED_TOKEN_ENV];
  if (!token) {
    console.error(`restart-policy-backfill: set ${SHARED_TOKEN_ENV} (needed to resolve each VPS's address)`);
    process.exit(1);
  }
  const identityFile = process.env[FLEET_SSH_IDENTITY_ENV];
  if (!identityFile) {
    console.error(`restart-policy-backfill: set ${FLEET_SSH_IDENTITY_ENV} (SSH private key path)`);
    process.exit(1);
  }
  const user = process.env[FLEET_SSH_USER_ENV] ?? "root";

  let pending = 0;
  let updated = 0;
  let failed = 0;

  for (const vpsId of loadSandboxAllowlist()) {
    const client = new HostingerClient({ apiToken: token });
    const vps = await client.getVps(vpsId);
    const ipv4 = vps.ipv4?.[0]?.address;
    if (!ipv4) {
      console.error(`restart-policy-backfill: VPS ${vpsId} has no IPv4 address — skipped`);
      failed += 1;
      continue;
    }
    const ssh = new ExecSshRunner({ host: ipv4, user, identityFile });

    // One round trip for every container on the box: `docker ps` cannot print a
    // restart policy, so inspect every id and filter here.
    const listed = await ssh.exec(
      `docker ps -aq | xargs -r docker inspect --format ` +
        `'{{.Id}} {{.Name}} {{index .Config.Labels "com.docker.compose.project"}} ` +
        `{{.HostConfig.RestartPolicy.Name}}'`,
    );
    if (listed.code !== 0) {
      console.error(`restart-policy-backfill: VPS ${vpsId} — inspect failed: ${listed.stderr.trim()}`);
      failed += 1;
      continue;
    }
    const targets = parseContainers(listed.stdout).filter((c) => c.project.endsWith("-prod"));
    console.log(`restart-policy-backfill: VPS ${vpsId} (${ipv4}) — ${targets.length} contenedor(es) -prod`);

    for (const c of targets) {
      if (c.policy === WANTED) {
        console.log(`  ya cumplía   ${c.name}  ${c.policy}`);
        continue;
      }
      if (!APPLY) {
        pending += 1;
        console.log(`  PENDIENTE    ${c.name}  ${c.policy} → ${WANTED} (re-run with --apply)`);
        continue;
      }

      assertSandboxVps(vpsId, `restart-policy backfill of ${c.name}`);
      const res = await ssh.exec(`docker update --restart ${WANTED} ${c.id}`);
      if (res.code !== 0) {
        failed += 1;
        console.error(`  FALLÓ        ${c.name}  docker update exit ${res.code}: ${res.stderr.trim()}`);
        continue;
      }
      // End state, measured — not inferred from the update's exit code.
      const after = await ssh.exec(
        `docker inspect ${c.id} --format '{{.Id}} {{.HostConfig.RestartPolicy.Name}}'`,
      );
      const [afterId, afterPolicy] = after.stdout.trim().split(/\s+/);
      if (after.code !== 0 || afterPolicy !== WANTED || afterId !== c.id) {
        failed += 1;
        console.error(
          `  FALLÓ        ${c.name}  after update: policy=${afterPolicy ?? "?"} ` +
            `id=${afterId === c.id ? "same" : "CHANGED — container was recreated"}`,
        );
        continue;
      }
      updated += 1;
      console.log(`  actualizado  ${c.name}  ${c.policy} → ${afterPolicy} (id sin cambios)`);
    }
  }

  console.log(
    `restart-policy-backfill: ${updated} actualizado(s), ${pending} pendiente(s), ${failed} fallo(s)`,
  );
  if (failed > 0) process.exitCode = 1;
}

// Guarded so the parser above can be exercised by hand against real `docker
// inspect` output, with no SSH and no docker (verification #14).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`restart-policy-backfill: ${err?.message ?? err}`);
    process.exit(1);
  });
}
