"use client";

// Client wrapper for poll-driven motion. Introduced for the Hangar dashboard
// (spec 0040 Scope 3); moved out of components/hangar/ to a shared location
// (spec 0041 item 2) once the Forge spec inbox's status pill needed the same
// #13 pill-swap-on-poll-change behavior — same pattern as this spec's
// `usePrefersReducedMotion` hook extraction (item 1). Detects when a
// server-rendered value CHANGES across a 3s router.refresh() and fires the
// corresponding DESIGN.md §4.2 animation:
//   - #5 value-flash (default mode)  — a `.kv .v` / status value whose text
//     changed: `.value-flash` (globals.css) fades an `--accent-dim` bg over
//     600ms.
//   - #13 pill-swap (`mode="swap"`) — a status pill LABEL changing
//     (running→waiting, etc.): `.pill-swap` crossfades over 150ms.
//   - #10 card-crossfade (`mode="card"`, item 4) — a gate/phase card's
//     content swapping after an action or the 3s poll refresh: `.card-
//     crossfade` fades + 2px-blurs over `--dur-2`. `as="div"` since a card's
//     content is block-level (the default `<span>` wrapper only fits inline
//     text like a `.kv .v`/pill label).
// All three are one-shot @keyframes (0039), not transitions — a CSS class
// doesn't replay an already-applied keyframe, so on each value change we
// remount the wrapping element via `key`, which is what makes the animation
// fire again on every poll rather than only once. Reduced-motion: the
// globals.css backstop neutralizes all three (#5 RM = none, #13/#10 RM =
// instant) — no extra call-site work.
import { useEffect, useRef, useState, type ReactNode } from "react";

export function LiveValue({
  value,
  className = "",
  mode = "flash",
  as = "span",
  children,
}: {
  value: string;
  className?: string;
  mode?: "flash" | "swap" | "card";
  as?: "span" | "div";
  children?: ReactNode;
}) {
  const prevValue = useRef(value);
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    if (prevValue.current !== value) {
      prevValue.current = value;
      setPulse((p) => p + 1);
    }
  }, [value]);

  const animClass =
    pulse > 0 ? (mode === "swap" ? "pill-swap" : mode === "card" ? "card-crossfade" : "value-flash") : "";
  const As = as;
  return (
    <As key={pulse} className={[className, animClass].filter(Boolean).join(" ")}>
      {children}
    </As>
  );
}
