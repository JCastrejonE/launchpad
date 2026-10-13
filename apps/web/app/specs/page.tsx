// Spec 0038 (item 3): the spec inbox moved to `/forge/specs`. This stub
// 308-redirects old bookmarks/links there.
import { permanentRedirect } from "next/navigation";

export default function SpecsRedirect() {
  permanentRedirect("/forge/specs");
}
