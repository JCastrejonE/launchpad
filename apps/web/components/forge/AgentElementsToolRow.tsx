"use client";
/**
 * Spec 0144 D: the transcript's tool rows render through the vendored
 * Agent Elements cards (components/agent-elements/, pulled from their shadcn
 * registry) instead of our one-line dot row — Claude-Code-grade tool cards
 * (bash with output, edits with diff stats, todo checklists, subagents)
 * without rebuilding them.
 *
 * The bridge is deliberately thin: the cards already tolerate assistant-ui's
 * part shape (`part.input ?? part.args`, `part.output ?? part.result`), and
 * their registry keys on `part.type === "tool-<Name>"`. So we re-type the part
 * and derive the AI-SDK-style `state` the cards switch on. Anything without a
 * dedicated card renders as their GenericTool row, titled from their registry
 * when it knows the tool and from our `describeStep` whitelist when it doesn't
 * (never raw input — a Write carries whole files).
 */
import type { ReactNode } from "react";
import { useMessagePart } from "@assistant-ui/react";
import { Collapsible } from "@base-ui/react/collapsible";
import { IconChevronRight } from "@tabler/icons-react";
import { describeStep } from "../../lib/forge-chat-runtime";
import { BashTool } from "../agent-elements/tools/bash-tool";
import { EditTool } from "../agent-elements/tools/edit-tool";
import { TodoTool } from "../agent-elements/tools/todo-tool";
import { SubagentTool } from "../agent-elements/tools/subagent-tool";
import { GenericTool } from "../agent-elements/tools/generic-tool";
import { toolRegistry } from "../agent-elements/tools/tool-registry";
import { cn } from "../agent-elements/utils/cn";

type BridgedPart = {
  type: string;
  toolCallId: string;
  state: "input-available" | "output-available" | "output-error";
  input: Record<string, unknown>;
  output?: unknown;
  // The cards also read these assistant-ui aliases; keep both populated.
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
};

export function AgentElementsToolRow() {
  const part = useMessagePart();
  if (part.type !== "tool-call") return null;

  const finished = part.result !== undefined;
  const failed = part.isError === true;
  const bridged: BridgedPart = {
    type: `tool-${part.toolName}`,
    toolCallId: part.toolCallId ?? `${part.toolName}-row`,
    state: failed ? "output-error" : finished ? "output-available" : "input-available",
    input: (part.args as Record<string, unknown>) ?? {},
    output: part.result,
    toolName: part.toolName,
    args: (part.args as Record<string, unknown>) ?? {},
    result: part.result,
  };

  const card = renderCard(bridged, part.toolName, finished, failed);

  // Spec 0147 §2: a *pending* call renders inline exactly as today — the
  // current-step/thinking bar carries "what's happening now". Once a call is
  // finished it's demoted to a collapsed one-liner so N tool calls no longer
  // read as N full cards; the detail stays one click away.
  if (!finished) return card;

  return (
    <Collapsible.Root className="flex flex-col gap-1 w-full" defaultOpen={false}>
      <Collapsible.Trigger className="group flex items-center gap-1 min-w-0 cursor-pointer text-left">
        <IconChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
            "rotate-0 group-data-panel-open:rotate-90",
          )}
        />
        <span className="text-sm text-muted-foreground truncate min-w-0">
          {describeStep(part.toolName, bridged.input)}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel
        className={cn(
          "overflow-hidden",
          "h-[var(--collapsible-panel-height)] transition-all duration-150 ease-out",
          "data-ending-style:h-0 data-starting-style:h-0",
          "[&[hidden]:not([hidden='until-found'])]:hidden",
        )}
      >
        {card}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function renderCard(
  bridged: BridgedPart,
  toolName: string,
  finished: boolean,
  failed: boolean,
): ReactNode {
  switch (toolName) {
    case "Bash":
      return <BashTool part={bridged} />;
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return <EditTool part={bridged} />;
    case "TodoWrite":
      return <TodoTool part={bridged} />;
    case "Task":
      return <SubagentTool part={bridged} />;
    default: {
      const meta = toolRegistry[bridged.type];
      const title = meta ? meta.title(bridged) : toolName;
      const subtitle = meta?.subtitle
        ? meta.subtitle(bridged)
        : (describeStep(toolName, bridged.input) ?? undefined);
      return (
        <GenericTool
          {...(meta ? { icon: meta.icon } : {})}
          title={title}
          {...(subtitle ? { subtitle } : {})}
          isPending={!finished}
          isError={failed}
        />
      );
    }
  }
}
