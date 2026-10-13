"use client";

// Hangar dashboard 3s live poll (spec 0040 Scope 3). Same mechanism as Forge's
// PipelinePoller: router.refresh() re-runs the `/` server component so the fleet
// facts, per-host live inventory, and deploy state stay current — which is what
// gives #5 value-flash / #13 pill-swap something to animate on. No WebSockets.
//
// Unlike PipelinePoller there's no terminal state to gate on (a pipeline run
// finishes; the fleet dashboard is always "live" while mounted) — so the
// interval runs unconditionally for as long as `/` is on screen.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 3000;

export default function FleetPoller() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
