/**
 * The one NextAuth (Auth.js v5) binding (spec 0073). Lives in app/ — not
 * lib/ — because `next-auth` is ESM-only and lib must also compile as CJS
 * for `node --test`. All decisions live in lib/auth-core.ts; this file only
 * wires them to the framework.
 *
 * GitHub OAuth is the ONLY provider (spec 0128 B2, the owner's call). It replaced the
 * Credentials (email + password) sign-in of spec 0073: one flow now yields both the
 * identity and the token the per-user repo-access checks need, and there is exactly
 * one way to become a given account. JWT sessions;
 * the role claim is stamped at sign-in and re-derived per request by
 * `sessionRoleFromToken` (unknown/missing → VIEWER, never OWNER).
 *
 * `trustHost: true`: self-hosted deployment (not Vercel). This only affects
 * callback-URL construction — the Host header is NOT a trust boundary
 * anywhere in this app (that was audit finding #2); authorization comes from
 * the signed session cookie alone.
 */
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { findUserByEmail, linkGithubIdentity } from "@launchpad/db";
import {
  sessionRoleFromToken,
  tokenWithUser,
  type UserRole,
} from "../lib/auth-core";
import { capabilityDenial, type Capability } from "../lib/capabilities";
import { recordAudit } from "../lib/audit";
import { getDb } from "../lib/db";
import { isSupervisorConsoleEnabled } from "../lib/env";
import { admitGithubSignIn } from "../lib/oauth-admission";
import { fetchVerifiedGithubEmails } from "../lib/github-emails";
import { storeUserGithubToken } from "../lib/user-github-token";
import { checkSupervisorAccess, type SupervisorAccessResult } from "../lib/supervisor-console";
import { authConfig } from "./auth.config";

/**
 * Spec 0213 B2: `session`, `trustHost`, `pages` and the shared session COOKIE now
 * come from `authConfig` rather than being restated here.
 *
 * They used to be duplicated by hand in both files, and that drift caused a live
 * bug the moment the two disagreed: the cookie was configured here, middleware
 * builds its own NextAuth instance from `authConfig`, and so the route gate hunted
 * for a cookie name nothing was writing. Spreading is the fix that keeps them
 * honest — a field added to the base reaches both readers automatically.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    /**
     * Spec 0128 B. **GitHub is the ONLY provider** — the Credentials fallback this
     * comment used to describe was removed once a real GitHub sign-in had
     * succeeded (0128 B2), and the `signIn` callback below refuses every other
     * provider by name. Corrected in spec 0213 B3 because the stale version cost a
     * session: it read as "there is a password login", which made a staging
     * environment look signable-into without a second OAuth app. There is no
     * password login. There is no way in but GitHub.
     *
     * `authorization.scope`: `read:user user:email repo`.
     *
     * `repo` is here for ONE reason (spec 0128 F): performing a promotion as the
     * person who clicked it. GitHub requires that scope to merge a pull request in a
     * private repository, and the merge IS the production deploy — so without it the
     * whole "a promotion is that person's act, enforced by GitHub" property collapses
     * back to merging as a shared bot.
     *
     * The cost, approved by the owner explicitly: this token can write to **every private
     * repo that person can reach**, not only the ones we manage. OAuth apps cannot
     * scope a token to specific repositories — a GitHub **App** can, and that is the
     * right destination before anyone outside the company signs in. Until then the
     * mitigations are: encrypted at rest, never in the JWT, only ever used to merge
     * (pushes and PR-opens still use GITHUB_TOKEN), and revocable by the user at
     * github.com/settings/applications at any time.
     *
     * Note that permission CHECKS deliberately do NOT use this token — the server
     * token asks GitHub what a login may do (packages/github/src/collaborator.ts) —
     * so a stale or revoked user token degrades promotion, never authorization.
     *
     * Changing this scope re-prompts every user for consent on their next sign-in;
     * the token stored before the change keeps its old, narrower scope.
     */
    GitHub({
      authorization: { params: { scope: "read:user user:email repo" } },
    }),
  ],
  events: {
    // Spec 0075: sign-in/out are effectful (they mint/kill the capability
    // every other gate trusts). Fail-open like every audit write.
    async signIn({ user }) {
      const email = user.email ?? "unknown";
      await recordAudit({ actor: email, action: "auth.signin", target: email });
    },
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      const email = typeof token?.email === "string" ? token.email : "unknown";
      await recordAudit({ actor: email, action: "auth.signout", target: email });
    },
  },
  callbacks: {
    /**
     * Spec 0128 B / decision 3a — **the file that keeps this console private.**
     *
     * The password login used to close the door by construction: no matching row,
     * no session.
     * An OAuth provider has no such property, so an explicit refusal is required
     * — without this callback, anyone on the internet with a GitHub account gets
     * a session on launchpad.example.com. `events.signIn` cannot do this job: it
     * writes an audit row and its return value is ignored.
     *
     * The policy is `admitGithubSignIn` (pure, tested); this supplies the lookup
     * and GitHub's verified-email list, then records the link on success.
     */
    signIn: async ({ user, account, profile }) => {
      // Spec 0128 B2: GitHub is now the ONLY provider, so this callback is the sole
      // gate on the whole console. Anything that is not GitHub is refused rather
      // than waved through — a provider added later must come here deliberately.
      if (account?.provider !== "github") return false;
      const login = typeof profile?.["login"] === "string" ? profile["login"] : null;
      const githubId = profile?.["id"] !== undefined ? String(profile["id"]) : null;
      // The profile email may be null (a private one), so ask the API for the
      // VERIFIED set — an unverified address must never claim an authorised row.
      const verifiedEmails = await fetchVerifiedGithubEmails(account.access_token, user.email);

      const db = getDb();
      let matched: string | null = null;
      let refusal = "Esta cuenta de GitHub no está autorizada. Pide a un administrador que te dé acceso.";
      for (const email of verifiedEmails) {
        const row = await findUserByEmail(db, email);
        const decision = admitGithubSignIn({
          login,
          verifiedEmails: [email],
          lookup: () => (row ? { email: row.email, githubLogin: row.githubLogin } : null),
        });
        if (decision.ok) {
          matched = decision.email;
          break;
        }
        refusal = decision.reason;
      }

      const attempted = login ?? user.email ?? "unknown-github-account";
      if (!matched) {
        await recordAudit({
          actor: attempted,
          action: "auth.signin_refused",
          target: attempted,
          metadata: { provider: "github", reason: refusal },
        });
        return false;
      }

      if (login && githubId) await linkGithubIdentity(db, matched, { login, githubId });

      // Spec 0128 F: keep the token so a promotion can be performed AS this
      // person. Encrypted at rest and never placed in the JWT (decision 4) — the
      // JWT goes to the browser, so a token in it is a credential given away.
      // A failure here must not block the sign-in: the consequence is "cannot
      // promote as you yet", not "cannot log in".
      if (account.access_token) {
        try {
          await storeUserGithubToken(matched, account.access_token);
        } catch {
          // Deliberately swallowed; the promote path reports the absence itself.
        }
      }
      // Auth.js builds the session from `user`, so point it at the authorised row
      // rather than whatever GitHub reported.
      user.email = matched;
      return true;
    },
    /**
     * Stamp the role claim (spec 0128 B fix, found by the 0129 D live test).
     *
     * The role lives in OUR `users` table, not at GitHub. The Credentials provider
     * used to attach it inside `authorize`, so `tokenWithUser` had it to stamp; an
     * OAuth profile carries no `role`, so the claim went missing and
     * `sessionRoleFromToken` degraded every GitHub session to VIEWER — correctly,
     * per least privilege, which is why nothing crashed and an OWNER simply could
     * not act. That is what "This needs the MEMBER or OWNER role — your session is
     * VIEWER" meant for an account that IS the OWNER.
     *
     * `user` is present only on the sign-in call, so this is one query per sign-in,
     * not per request. The row is authoritative: whatever GitHub says about the
     * person, their permissions here come from our table.
     */
    jwt: async ({ token, user }) => {
      if (!user?.email) return tokenWithUser(token, user);
      const row = await findUserByEmail(getDb(), user.email);
      if (!row) return token;
      return tokenWithUser(token, { id: row.id, role: row.role });
    },
    session: ({ session, token }) => {
      session.user.role = sessionRoleFromToken(token["role"] as unknown);
      return session;
    },
  },
});

/** The session's role, VIEWER when signed out — single accessor so gating
 * code (spec 0074) never reads the token shape directly. */
export async function currentRole(): Promise<UserRole> {
  const session = await auth();
  return session?.user ? session.user.role : "VIEWER";
}

/** True only for a signed-in OWNER session — the gate every mutating
 * route/action checks in spec 0074 (destructive actions are OWNER-only,
 * SPEC §13). */
export async function isOwnerSession(): Promise<boolean> {
  const session = await auth();
  return session?.user?.role === "OWNER";
}

/** The session email iff the session is a signed-in OWNER, else null — the
 * verified ACTOR stamped on every mutating web action (spec 0074; replaced
 * the unverified GATE_ACTOR_EMAIL env string). */
export async function ownerEmail(): Promise<string | null> {
  const session = await auth();
  if (session?.user?.role !== "OWNER") return null;
  return session.user.email ?? null;
}

/** The session role, null when signed out — shape `checkSupervisorAccess`
 * and `resolveForgeRootSurface` take. */
export async function sessionRole(): Promise<UserRole | null> {
  const session = await auth();
  return session?.user ? session.user.role : null;
}

/**
 * Outcome of a capability check (spec 0117). Carries `actor` on the FAILURE
 * branch too: a refused promote by a signed-in MEMBER is exactly the event a
 * three-person control plane wants in `audit_log`, and it is only attributable
 * if the denial knows who was asking.
 */
export type CapabilityCheck =
  | { ok: true; actor: string }
  | { ok: false; actor: string | null; reason: string };

/**
 * The capability-aware sibling of {@link ownerEmail} (spec 0117): resolves the
 * session and answers "may this actor do X", returning the verified session
 * email as the actor when yes.
 *
 * Same anti-footgun shape as `ownerEmail` — the identity you stamp on the
 * mutation is the same value the authorization produced, so it is impossible to
 * record an actor you did not authorize. Policy lives in lib/capabilities.ts;
 * this only supplies the session.
 */
export async function actorFor(capability: Capability): Promise<CapabilityCheck> {
  const session = await auth();
  const role = session?.user ? session.user.role : null;
  const actor = session?.user?.email ?? null;
  const denial = capabilityDenial(role, capability);
  if (denial) return { ok: false, actor, reason: denial };
  // A signed-in session with a capability but no email cannot happen (email is
  // the credential), but the type must not lie — fail closed rather than stamp
  // an empty actor on a mutation.
  if (!actor) return { ok: false, actor: null, reason: "Session has no email — sign in again." };
  return { ok: true, actor };
}

/** The verified session email regardless of role — spec 0135's actor for a
 * member chat turn. Same anti-footgun shape as `ownerEmail`: the value you
 * stamp is the value the session produced. */
export async function sessionEmail(): Promise<string | null> {
  const session = await auth();
  return session?.user?.email ?? null;
}

/**
 * The one place the supervisor gate is composed for route handlers — every
 * `/api/supervisor*` verb calls this so the policy can't drift between routes
 * (spec 0074). Spec 0135 adds the project scope: pass the project this
 * request is about (`projectId` when the caller holds a thread row, or
 * `projectSlug`) and membership admits a MEMBER; omit it and the check stays
 * OWNER-only — that unscoped surface is a shell on the launchpad's own
 * checkout. Any lookup failure reads as "not a member": fail closed.
 */
export async function supervisorAccess(
  scope: { projectId?: string | null; projectSlug?: string | null } = {},
): Promise<SupervisorAccessResult> {
  const enabled = isSupervisorConsoleEnabled(process.env);
  const role = await sessionRole();
  let projectMember: boolean | undefined;
  const scoped = Boolean(scope.projectId || scope.projectSlug);
  if (scoped && role !== null && role !== "OWNER") {
    projectMember = false;
    try {
      const email = await sessionEmail();
      if (email) {
        const { membershipFor, projectBySlug, userIdsByEmail } = await import("@launchpad/db");
        const { getDb } = await import("../lib/db");
        const db = getDb();
        const projectId =
          scope.projectId ??
          (scope.projectSlug ? ((await projectBySlug(db, scope.projectSlug))?.id ?? null) : null);
        const userId = projectId ? (await userIdsByEmail(db, [email])).get(email) : undefined;
        if (projectId && userId) {
          projectMember = (await membershipFor(db, projectId, userId)) !== null;
        }
      }
    } catch {
      projectMember = false;
    }
  }
  return checkSupervisorAccess({
    enabled,
    role,
    ...(projectMember !== undefined ? { projectMember } : {}),
  });
}


/**
 * Spec 0143/0144 E: is this session a member of this project?
 *
 * Gates both VIEWING the workspace (0143) and ACTING on it (0144 E) — the
 * same question, and deliberately one function so the two can never drift.
 * The capability check (`actorFor`) answers "may this ROLE do this KIND of
 * thing"; this answers "on THIS project". Both are required for an action.
 *
 * `listProjectsFor` (0128) scoped what the dashboard LISTS; nothing ever
 * re-checked on the project routes themselves, so a removed member — or any
 * signed-in account with the URL — could still open the whole workspace. The owner
 * caught it live. Fail closed: no session, no project id, or a DB error all deny.
 *
 * **Spec 0168: the global role no longer grants project access.** This used to
 * begin `if (role === "OWNER") return true` — 0128 decision 7's see-everything
 * rule, which was harmless while OWNER meant one person. v0 makes every user an
 * OWNER (the owner: *"max 5 users… every user will be an Owner"*), so that line would
 * hand all five of them every project, and the requested boundary — *"not
 * everyone will be able to write on every project, even if they are owners of
 * their own"* — could not exist while it stood. Membership is now the whole
 * answer here; `actorFor` still answers the separate question of what a role may
 * do at all.
 */
export async function isProjectMember(projectId: string): Promise<boolean> {
  const role = await sessionRole();
  if (role === null) return false;
  try {
    const email = await sessionEmail();
    if (!email) return false;
    const { membershipFor, userIdsByEmail } = await import("@launchpad/db");
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const userId = (await userIdsByEmail(db, [email])).get(email);
    if (!userId) return false;
    return (await membershipFor(db, projectId, userId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Spec 0144 E: is this session a member of the PLATFORM project?
 *
 * `/forge/specs` acts on this repo's own specs, so its actions are
 * platform-scoped. It matters beyond tidiness while workflow ids are still
 * `spec-<id>` (spec 0142 C): a gate signal there addresses a workflow by spec
 * id alone, and a project's `spec-0001` shares that id — so without this, any
 * signed-in MEMBER could signal a customer project's run from the platform
 * surface. Fail-closed like its sibling.
 */
export async function isPlatformMember(): Promise<boolean> {
  try {
    const { projectBySlug } = await import("@launchpad/db");
    const { getDb } = await import("../lib/db");
    const platform = await projectBySlug(getDb(), "platform");
    if (!platform) return false;
    return await isProjectMember(platform.id);
  } catch {
    return false;
  }
}
