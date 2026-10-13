"use client";

/**
 * Per-panel live updates for the project workspace (spec 0155).
 *
 * Replaces the blanket 8s `router.refresh()` (spec 0143) with: ask whether THIS
 * panel's data moved, and refresh only if it did.
 *
 * Three guards, each earned:
 *
 *  1. **Only the visible panel, only if it is live.** A static panel
 *     (Repositorio, Ajustes, Terminal…) polls nothing at all, and no panel pays
 *     for another panel's data. The old refresh re-rendered every panel on the
 *     route, including the one that SSHes into a VPS, while you sat on Chats.
 *
 *  2. **Never while the user is aiming.** `router.refresh()` rebuilds the
 *     subtree, so a button can be replaced between mousedown and mouseup — the
 *     click lands on a node that is no longer in the document and nothing
 *     happens. Focus in a field already paused it (0143, after a typed branch
 *     name was eaten); recent pointer MOVEMENT now does too, because a moving
 *     pointer is a click about to happen.
 *
 *  3. **Only on a real change.** The digest is the gate. An unchanged digest
 *     touches no DOM, which is what makes the common case free.
 *
 * A failed poll is silent and simply leaves the digest unchanged: an outage must
 * not become a refresh storm.
 */
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 8000;
/** How long after the pointer moves we consider the user to be aiming. */
const AIMING_MS = 1500;

export function PanelLive({ projectSlug, panel }: { projectSlug: string; panel: string }) {
  const router = useRouter();
  // Refs, not state: nothing here should cause a render of its own.
  const digestRef = useRef<string | null>(null);
  const lastPointerRef = useRef(0);
  const inFlightRef = useRef(false);

  // Pointer movement is tracked for as long as this panel is mounted, not only
  // while a poll is pending — the timestamp has to already be there when the
  // poll fires.
  useEffect(() => {
    const onMove = () => {
      lastPointerRef.current = Date.now();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // Panel changed ⇒ the previous panel's digest says nothing about this one.
  useEffect(() => {
    digestRef.current = null;
  }, [panel]);

  useEffect(() => {
    let cancelled = false;
    const id = setInterval(async () => {
      if (document.hidden) return;
      if (inFlightRef.current) return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el instanceof HTMLElement && el.isContentEditable) return;
      if (Date.now() - lastPointerRef.current < AIMING_MS) return;

      inFlightRef.current = true;
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectSlug)}/live?panel=${encodeURIComponent(panel)}`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled) return;
        const { digest } = (await res.json()) as { digest: string | null };
        if (cancelled || digest === null) return;
        const previous = digestRef.current;
        digestRef.current = digest;
        // The FIRST reading is a baseline, not a change: the page was rendered
        // from this same data moments ago.
        if (previous !== null && previous !== digest) router.refresh();
      } catch {
        // Offline, navigating away, server restarting — try again next tick.
      } finally {
        inFlightRef.current = false;
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectSlug, panel, router]);

  return null;
}
