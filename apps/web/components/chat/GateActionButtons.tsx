"use client";

/**
 * Shared Approve/Reject/Promote button row for the chat's gate cards (spec
 * 0016 item 6b). Every button calls the EXISTING `signalGateAction` — the
 * same server action (+ session-actor recording, spec 0074) the spec detail page's
 * buttons already use (spec 0016 Scope: "the click calls the same server
 * action as today"). The model can never fire these itself — chat-tools.ts's
 * `render*Card` handlers are read-only (spec 0016's core safety invariant,
 * unit-tested in chat-tools.test.ts); only this component's onClick does.
 */
import { useState } from "react";
// Spec 0101: the shadcn Button is gone; this uses the Mission Control template's
// own `Btn`. Variant map: shadcn `default` (filled accent) → `primary`, shadcn
// `outline` (bordered neutral) → `default`. The template has no size prop, so
// the old `size="sm"` becomes an explicit compact override.
import { Btn } from "../ui";
import { signalGateAction } from "../../app/forge/specs/[filename]/actions";
import { GATE_ACTION_LABEL, type GateSignal } from "../../lib/gate-actions";

export function GateActionButtons({
  filename,
  specId,
  actions,
}: {
  filename: string;
  specId: string;
  actions: GateSignal[];
}) {
  const [pending, setPending] = useState<GateSignal | null>(null);
  const [sent, setSent] = useState<GateSignal | null>(null);

  if (actions.length === 0) return null;

  async function handleClick(action: GateSignal) {
    setPending(action);
    try {
      await signalGateAction(filename, specId, action);
      setSent(action);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {actions.map((action) => (
        <Btn
          key={action}
          variant={action === "specRejected" ? "default" : "primary"}
          className="h-8 px-3 text-xs disabled:pointer-events-none disabled:opacity-50"
          disabled={pending !== null || sent !== null}
          onClick={() => handleClick(action)}
        >
          {pending === action ? "Enviando…" : sent === action ? "Enviado" : GATE_ACTION_LABEL[action]}
        </Btn>
      ))}
    </div>
  );
}
