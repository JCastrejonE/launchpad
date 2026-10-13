// Spec 0060: the supervisor console moved to `/forge`. Spec 0082 (C.3): the
// standalone console is retired altogether — its chat is the project
// workspace's "Chats · sdd" tab now — so this points at the Launchpad (`/`)
// instead of chaining through the retired `/forge`. Mirrors the spec-0038 stub
// pattern (`app/chat/page.tsx`, `app/fleet/page.tsx`, `app/specs/page.tsx`).
import { permanentRedirect } from "next/navigation";

export default function SupervisorRedirect() {
  permanentRedirect("/");
}
