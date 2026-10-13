// Spec 0025: chat moved to the front door (`/`). Spec 0038 (item 3): the front
// door became the Hangar dashboard and chat lived at `/forge`. Spec 0082 (C.3):
// `/forge` is retired too — chat is now the project workspace's "Chats · sdd"
// tab, so this points at the Launchpad (`/`) rather than chaining through a
// second redirect.
import { permanentRedirect } from "next/navigation";

export default function ChatRedirect() {
  permanentRedirect("/");
}
