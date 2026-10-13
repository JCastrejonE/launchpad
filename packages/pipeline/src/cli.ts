/**
 * Pipeline CLI — dev interface until apps/web grows the UI (phase 5).
 *
 *   cli start <specId> "<plain language request>"   # THIS repo only — see the
 *     case below. A run for any other project must be started from the web
 *     (`startPipeline`), which resolves the project's checkout.
 *   cli start-tenant <specId> "<request>" --tenant <id> --vps-id <n> \
 *     [--odoo-version <17|18|19>]                    # begins a tenant-target pipeline
 *     (spec 0026: gate 3 promote on a tenant run performs the live Odoo deploy
 *     to the given VPS. For a deploy-only run, phrase <request> as "no code
 *     changes; plan only (human) items" so the initializer converges without
 *     coder sessions — spec-0006 behavior.)
 *   cli approve-spec <specId> <email>               # gate 1
 *   cli approve-pr <specId> <email>                 # gate 2
 *   cli promote <specId> <email>                    # gate 3 (humans only)
 *   cli reject <specId> <email> "<reason>"
 *   cli status <specId>
 */
import { Client, Connection } from "@temporalio/client";
import { specPipeline, specApproved, specRejected, prApproved, promote } from "./workflow.js";
import { TASK_QUEUE, SPEC_PIPELINE_WORKFLOW_TYPE } from "./task-queue.js";
import type { OdooVersion } from "./spec.js";

function usage(): never {
  console.error(
    "usage: cli <start|start-tenant|approve-spec|approve-pr|promote|reject|status> <specId> [...]",
  );
  process.exit(1);
}

/** Looks up a `--flag value` pair anywhere in argv (order-independent). */
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, specId, arg3, arg4] = argv;
  if (!cmd || !specId) usage();
  const connection = await Connection.connect({
    address: process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
  });
  const client = new Client({ connection });
  const workflowId = `spec-${specId}`;

  switch (cmd) {
    /**
     * The LAUNCHPAD-ONLY start (spec 0131 D). It targets `LAUNCHPAD_REPO_ROOT`
     * and resolves no project, which is correct for the developer running it
     * from a shell in this checkout — and wrong for anything else.
     *
     * The UI must never reach this path. It used to: the Start button spawned
     * `supervise.mjs`, which ran `cli start`, so a run for a customer project
     * worked on the launchpad's own repository (spec 0129 D failed that way
     * twice). Since spec 0131 A the web starts runs through `startPipeline`,
     * which resolves the run's checkout from the spec's project, and
     * `supervise.mjs` only attaches. Do NOT teach this command to resolve
     * projects — two implementations of "which repo does this run use" is the
     * defect, not the fix.
     */
    case "start": {
      if (!arg3) usage();
      const repo = process.env["LAUNCHPAD_REPO_ROOT"];
      if (!repo) throw new Error("LAUNCHPAD_REPO_ROOT not set");
      const handle = await client.workflow.start<typeof specPipeline>(SPEC_PIPELINE_WORKFLOW_TYPE, {
        taskQueue: TASK_QUEUE,
        workflowId,
        args: [
          {
            specId,
            target: { kind: "self", repo },
            request: arg3,
            requestedBy: arg4 ?? "owner@example.com",
          },
        ],
      });
      console.log(`started ${handle.workflowId} — waiting at gate 1 after draft`);
      break;
    }
    case "start-tenant": {
      if (!arg3) usage();
      const repo = process.env["LAUNCHPAD_REPO_ROOT"];
      if (!repo) throw new Error("LAUNCHPAD_REPO_ROOT not set");
      const tenantId = flagValue(argv, "--tenant");
      if (!tenantId) throw new Error("start-tenant requires --tenant <id>");
      const vpsIdRaw = flagValue(argv, "--vps-id");
      if (!vpsIdRaw) throw new Error("start-tenant requires --vps-id <n>");
      const vpsId = Number(vpsIdRaw);
      if (!Number.isInteger(vpsId)) {
        throw new Error(`--vps-id must be an integer, got ${vpsIdRaw}`);
      }
      const odooVersionRaw = flagValue(argv, "--odoo-version") ?? "18";
      const odooVersionNum = Number(odooVersionRaw);
      if (odooVersionNum !== 17 && odooVersionNum !== 18 && odooVersionNum !== 19) {
        throw new Error(`--odoo-version must be 17, 18, or 19, got ${odooVersionRaw}`);
      }
      const odooVersion = odooVersionNum as OdooVersion;
      const handle = await client.workflow.start<typeof specPipeline>(SPEC_PIPELINE_WORKFLOW_TYPE, {
        taskQueue: TASK_QUEUE,
        workflowId,
        args: [
          {
            specId,
            target: { kind: "tenant", tenantId, repo, odooVersion, vpsId },
            request: arg3,
            requestedBy: "owner@example.com",
          },
        ],
      });
      console.log(`started ${handle.workflowId} — waiting at gate 1 after draft`);
      break;
    }
    case "approve-spec":
      await client.workflow.getHandle(workflowId).signal(specApproved, { approvedBy: arg3 ?? "" });
      console.log("spec approved (gate 1)");
      break;
    case "approve-pr":
      await client.workflow.getHandle(workflowId).signal(prApproved, { approvedBy: arg3 ?? "" });
      console.log("PR approved (gate 2)");
      break;
    case "promote":
      await client.workflow.getHandle(workflowId).signal(promote, { promotedBy: arg3 ?? "" });
      console.log("promotion signalled (gate 3)");
      break;
    case "reject":
      await client.workflow
        .getHandle(workflowId)
        .signal(specRejected, { rejectedBy: arg3 ?? "", reason: arg4 ?? "" });
      console.log("rejected");
      break;
    case "status": {
      const d = await client.workflow.getHandle(workflowId).describe();
      console.log(`${d.workflowId}: ${d.status.name}`);
      break;
    }
    default:
      usage();
  }
  await connection.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
