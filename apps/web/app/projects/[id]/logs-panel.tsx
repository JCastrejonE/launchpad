/**
 * Server-rendered container logs for this project's deployed stacks (spec 0214),
 * passed into the client `Logs` panel as props.
 *
 * A SLOT, not an import, for the same reason `DeployedStacksPanel` is one: the
 * read needs the Hostinger token and the SSH identity, which must never reach
 * the client bundle. `getProjectStackLogsSafe` returns plain data precisely so
 * it can cross into `panels.tsx` (a `"use client"` file).
 */
import { getProjectStackLogsSafe } from "@/lib/fleet";
import { Logs } from "./panels";

export async function LogsPanel({ slug }: { slug: string }) {
  return <Logs logs={await getProjectStackLogsSafe(slug)} />;
}
