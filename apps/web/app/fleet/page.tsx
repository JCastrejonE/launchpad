// Spec 0038 (item 3): `/fleet`'s content moved to `/` (the Hangar dashboard
// is now the root route). This stub 308-redirects old bookmarks/links there.
import { permanentRedirect } from "next/navigation";

export default function FleetRedirect() {
  permanentRedirect("/");
}
