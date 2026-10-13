"use client";

// Live updates while a pipeline run is in progress — spec 0005 Plan item 3.
// No WebSockets (non-goal); router.refresh() re-runs the server component on
// an interval, which re-fetches describePipeline() and the handoff log.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 3000;

/** Renders nothing — just schedules router.refresh() while `active` is true.
 * Parent decides `active` from PipelineViewState.state (running or
 * waiting_at_gate); pass false for not_started/completed/failed so polling
 * stops on its own once there's nothing left to watch. */
export default function PipelinePoller({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, router]);

  return null;
}
