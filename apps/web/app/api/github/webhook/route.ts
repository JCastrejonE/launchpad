/**
 * GitHub webhook: the trigger for our own CI (spec 0228 D).
 *
 * Deliberately does almost nothing. A webhook that does work is a webhook that
 * times out, so this verifies, decides whether the delivery is worth a gate, and
 * starts a workflow. Everything else happens in the worker.
 *
 * It is in `PUBLIC_PREFIXES` because GitHub has no session. The HMAC IS the
 * authentication, and it is checked BEFORE the body is parsed — a signature
 * verified over re-serialised JSON is not a signature over what was sent.
 */
import { NextResponse } from "next/server";
import { verifyGithubSignature, webhookTarget } from "@/lib/github-webhook";
import { getClient } from "@/lib/pipeline";
import { recordAudit } from "@/lib/audit";
import { TASK_QUEUE, CI_GATE_WORKFLOW_TYPE } from "@launchpad/pipeline";
import { ciGateWorkflowId } from "@launchpad/pipeline";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // RAW body, before any parsing: GitHub signed these exact bytes.
  const raw = await req.text();
  const verdict = verifyGithubSignature(
    process.env["GITHUB_WEBHOOK_SECRET"],
    raw,
    req.headers.get("x-hub-signature-256"),
  );
  if (!verdict.ok) {
    // 401 and nothing else: no workflow, no audit row keyed on unverified
    // content, and a reason terse enough not to help someone probe it.
    return NextResponse.json({ error: verdict.reason }, { status: 401 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "unparseable payload" }, { status: 400 });
  }

  const target = webhookTarget(event, payload);
  // 200, not an error: GitHub retries non-2xx, and "this event is not one we
  // gate" is a correct outcome rather than a failure to retry.
  if (!target) return NextResponse.json({ ok: true, gated: false, event });

  const client = await getClient();
  // The id is the commit, so two deliveries for one sha are one gate. Temporal
  // rejects a duplicate id, which is the dedup — not a check we have to write.
  await client.workflow
    .start(CI_GATE_WORKFLOW_TYPE, {
      taskQueue: TASK_QUEUE,
      workflowId: ciGateWorkflowId(target.sha),
      args: [{ sha: target.sha, owner: target.owner, repo: target.repo }],
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // An already-running gate for this sha is the dedup working, not a fault.
      if (!/already started|WorkflowExecutionAlreadyStarted/i.test(message)) throw err;
    });

  await recordAudit({
    actor: "github-webhook",
    action: "ci.gate.started",
    target: `${target.owner}/${target.repo}@${target.sha.slice(0, 8)}`,
    metadata: { event: target.event },
  });

  return NextResponse.json({ ok: true, gated: true, sha: target.sha });
}
