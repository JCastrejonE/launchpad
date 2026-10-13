"use client";

// Forge spec-inbox 3s live poll (spec 0041 item 2) — same mechanism as the
// Hangar dashboard's FleetPoller (spec 0040 Scope 3) and the spec-detail
// page's PipelinePoller: router.refresh() re-runs the `/forge/specs` server
// component so each row's spec.status and pipeline label stay current, which
// is what gives #1 live-dot, #4 progress-fill, and #13 pill-swap something to
// animate on. No WebSockets (non-goal).
//
// Unlike PipelinePoller there's no single terminal state to gate on — the
// inbox lists every spec, some running, some resting at a gate, some done —
// so (like FleetPoller) the interval runs unconditionally for as long as the
// inbox is on screen.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 3000;

export function SpecInboxPoller() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
