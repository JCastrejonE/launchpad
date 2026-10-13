/**
 * Server wrapper for `/new` (spec 0209). The wizard is a client component and
 * `auth()` is server-only, so the session is read here and the chrome user handed
 * down as a prop — the same split `/` already uses (`page.tsx` + `Launchpad.tsx`).
 */
import { sessionChromeUser } from "../chrome-user";
import { NewProject } from "./NewProject";

export default async function NewProjectPage() {
  return <NewProject user={await sessionChromeUser()} />;
}
