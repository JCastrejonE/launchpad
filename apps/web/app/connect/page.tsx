/**
 * Server wrapper for `/connect` (spec 0209). Same reason as `/new`: the wizard is a
 * client component, `auth()` is server-only, so the chrome user arrives as a prop.
 */
import { sessionChromeUser } from "../chrome-user";
import { ConnectProject } from "./ConnectProject";

export default async function ConnectProjectPage() {
  return <ConnectProject user={await sessionChromeUser()} />;
}
