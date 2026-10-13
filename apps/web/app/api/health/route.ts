import { Connection } from "@temporalio/client";
import { computeHealth, healthStatus } from "../../../lib/health";

/**
 * Cheap Temporal reachability probe for the health self-check (spec 0018
 * item 6): a real connection attempt with a short timeout, so a hung or
 * absent Temporal server degrades the body quickly instead of hanging this
 * request. Never throws — any failure just means "unreachable"; this is
 * informational only (see lib/health.ts) and never flips the HTTP status.
 */
async function probeTemporal(): Promise<boolean> {
  try {
    const connection = await Connection.connect({
      address: process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
      connectTimeout: "2s",
    });
    await connection.close();
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const result = await computeHealth(process.env, probeTemporal);
  return Response.json(result, { status: healthStatus(result) });
}
