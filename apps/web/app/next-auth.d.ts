/** Module augmentation (spec 0073): the SPEC §13 role rides on the session
 * user and the JWT. Type-only — compiled by the app tsconfig, never by
 * tsconfig.test.json (lib only). */
import type { DefaultSession } from "next-auth";
import type { UserRole } from "../lib/auth-core";

declare module "next-auth" {
  interface User {
    role: UserRole;
  }
  interface Session {
    user: {
      role: UserRole;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: UserRole;
    uid?: string;
  }
}
