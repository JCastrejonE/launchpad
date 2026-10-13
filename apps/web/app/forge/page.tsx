// Spec 0082 (C.3): the standalone Forge console is RETIRED. Its chat lives in
// the project workspace's "Chats · sdd" tab now (spec 0081, C.2) — the same
// assistant-ui + `/api/supervisor` SSE stack, project-scoped — so `/forge` was
// a duplicate front door that nothing even linked to (spec 0080 removed the
// NavBar). SPEC-ALIGNMENT §8 C.3 / CLAUDE.md "frozen surfaces": harvest the
// SSE bridge, retire the console.
//
// 308 rather than 404, matching the stub pattern this repo already uses for
// retired URLs (`/fleet`, `/specs`, `/chat`, `/forge/supervisor`; specs
// 0038/0060), so existing links and bookmarks keep working. `/forge/specs`
// (the spec inbox) is NOT retired here — a different surface, and the only
// real spec reader until C.4 re-homes it into the workspace tab.
import { permanentRedirect } from "next/navigation";

export default function ForgeRedirect() {
  permanentRedirect("/");
}
