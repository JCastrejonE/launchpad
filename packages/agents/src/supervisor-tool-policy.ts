import { posix } from "node:path";

/**
 * Bash command policy for the in-UI supervisor (spec 0070 / SPEC-ALIGNMENT
 * §10.B; audit finding #4). The supervisor is "inspect/steer only": it must
 * never fire a pipeline gate signal, push/commit, or write repo files. Before
 * this, that invariant was PROSE ONLY (`agents/supervisor.md`) — the session's
 * Bash tool was auto-approved, so a prompt-injected instruction the supervisor
 * reads ("run `node packages/pipeline/dist/cli.js promote 0032 x`") would
 * execute and fire the human-only promote gate (ADR-007 violation).
 *
 * {@link supervisorBashDenial} is the pure deny-decision; supervisor-session.ts
 * wires it into the SDK `canUseTool` gate (with `Bash` removed from
 * `allowedTools`, so `canUseTool` is consulted for every Bash call — per the
 * SDK, `allowedTools` is auto-approval, not availability).
 *
 * It is a TARGETED deny-list of the specific invariant-violating actions, not a
 * general sandbox: a semi-trusted operator agent, defended against
 * prompt-injection and accidental mutation — not against a determined adversary
 * obfuscating a command (e.g. base64-decode-and-pipe-to-sh). The deeper defense
 * — authenticating the Temporal signal path itself so no local process can
 * fire a gate — is tracked separately (SPEC-ALIGNMENT §3 A.2 / §10).
 */

/** A pipeline CLI reference (bin name, or the built/source cli entry). */
const PIPELINE_CLI_RE = /(?:launchpad-pipeline|cli\.js|packages\/pipeline\/(?:src|dist)\/cli)/i;

/** Mutating pipeline CLI verbs: the gate signals plus the workflow starters.
 * `status` is read-only and intentionally absent. */
const PIPELINE_MUTATING_VERB_RE = /\b(?:approve-spec|approve-pr|promote|reject|start|start-tenant)\b/;

/** A Temporal CLI signalling a workflow — an alternate gate-signal path. */
const TEMPORAL_SIGNAL_RE = /\btemporal\b.*\bworkflow\b.*\bsignal\b/i;

/** Mutating git subcommands (state / remote / history). Read-only git
 * (status, log, diff, show, rev-parse, blame, …) is allowed. */
const GIT_MUTATING_RE =
  /\bgit\s+(?:push|commit|merge|rebase|reset|cherry-pick|revert|clean|am|apply|stash\s+(?:push|drop|clear|pop))\b/i;

/** In-place / streaming file writers, matched only in COMMAND position (start,
 * or after a shell separator) so a mention as a path/argument (e.g.
 * `ls /usr/bin/tee`) is not flagged. */
const FILE_WRITER_CMD_RE = /(?:^|[\n;|&]|\|\||&&)\s*(?:sed\s+-i|tee|dd)\b/i;

/**
 * True when `cmd` redirects into a real FILE (`> f` / `>> f`). The redirect
 * `>` must be preceded by start-of-string or whitespace, which excludes fd
 * dups (`2>&1`, `>&2`), stderr redirects (`2>/dev/null`), and arrows in quoted
 * strings (`'%h -> %s'`); a `/dev/null` target is a discard, not a write.
 * Heuristic (see the module doc) — it won't catch a no-space `cmd>file`, an
 * acceptable gap for this threat model.
 */
function hasFileWriteRedirect(cmd: string): boolean {
  const re = /(?:^|\s)>>?\s*([^\s;&|>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const target = m[1];
    if (target && target !== "/dev/null") return true;
  }
  return false;
}

/**
 * Decide whether a supervisor Bash command must be denied. Returns the denial
 * reason (surfaced to the agent so it can adjust) or `null` to allow.
 */
export function supervisorBashDenial(command: string): string | null {
  const cmd = command ?? "";
  if (PIPELINE_CLI_RE.test(cmd) && PIPELINE_MUTATING_VERB_RE.test(cmd)) {
    return (
      "denied: the supervisor cannot run pipeline gate/start verbs " +
      "(approve-spec / approve-pr / promote / reject / start) — only a human's " +
      "gate-card click may signal a gate (ADR-007). Use `cli.js status` to inspect."
    );
  }
  if (TEMPORAL_SIGNAL_RE.test(cmd)) {
    return "denied: the supervisor cannot signal a Temporal workflow — gate signals are human-only (ADR-007).";
  }
  if (GIT_MUTATING_RE.test(cmd)) {
    return (
      "denied: the supervisor is inspect/steer only — no git push/commit/merge/" +
      "reset/rebase (it never mutates the repo or its remote)."
    );
  }
  if (FILE_WRITER_CMD_RE.test(cmd) || hasFileWriteRedirect(cmd)) {
    return (
      "denied: the supervisor is inspect/steer only — no file writes " +
      "(redirection to a file, tee, sed -i, dd). Read/Grep/Glob to inspect instead."
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spec 0140 — the PROJECT profile: a chat bound to a project + branch works in
// that project's checkout, so it may write there. What it still may not do is
// signal a gate (ADR-007, human-only) or administer the host it runs on.
// ---------------------------------------------------------------------------

/** Host administration — off-limits in BOTH profiles. A project chat may build
 * its project; it may not reconfigure the box, reach another host, or read the
 * runtime's secrets. `sudo` is included even though the session runs
 * unprivileged: a denial that names the rule beats a confusing permission
 * error, and the day the service user gains sudo this stays correct. */
const HOST_ADMIN_RE =
  /(?:^|[\n;|&]|\|\||&&)\s*(?:sudo|su\b|systemctl|service|docker|docker-compose|ssh|scp|rsync|shutdown|reboot|useradd|usermod|passwd|chown|chmod\s+[0-7]*777)\b/i;

/** Paths whose contents are credentials or host configuration. Matched
 * anywhere in the command (as a path, not only in command position): reading
 * them is the harm, whatever verb does it. */
const SENSITIVE_PATH_RE =
  /(?:\/etc\/launchpad|\/etc\/(?:passwd|shadow|sudoers)|launchpad\.env|\.git-credentials|\.ssh\/|id_rsa|id_ed25519|(?:^|[\s"'=/])\.env(?:\.[\w-]+)?\b)/i;

/** `rm -rf /` and friends — a slip that ends the box, in any profile. */
const CATASTROPHIC_RM_RE = /\brm\s+(?:-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+(?:\/|\/\*|~|\$HOME)\s*$/i;

/**
 * The clauses that hold in EVERY profile: gate signals stay human-only
 * (ADR-007), the host stays off-limits, secrets stay unread. Returns the
 * denial reason or `null`.
 */
export function universalBashDenial(command: string): string | null {
  const cmd = command ?? "";
  if (PIPELINE_CLI_RE.test(cmd) && PIPELINE_MUTATING_VERB_RE.test(cmd)) {
    return (
      "denied: no agent may run pipeline gate/start verbs " +
      "(approve-spec / approve-pr / promote / reject / start) — only a human's " +
      "gate-card click may signal a gate (ADR-007). Use `cli.js status` to inspect."
    );
  }
  if (TEMPORAL_SIGNAL_RE.test(cmd)) {
    return "denied: no agent may signal a Temporal workflow — gate signals are human-only (ADR-007).";
  }
  if (HOST_ADMIN_RE.test(cmd)) {
    return (
      "denied: host administration is out of scope (sudo/systemctl/docker/ssh/…). " +
      "You work inside this project's checkout, not on the machine running it."
    );
  }
  if (SENSITIVE_PATH_RE.test(cmd)) {
    return (
      "denied: that path holds credentials or host configuration " +
      "(.env / launchpad.env / .git-credentials / .ssh / /etc). Secrets never enter a chat."
    );
  }
  if (CATASTROPHIC_RM_RE.test(cmd)) {
    return "denied: a recursive delete of / or $HOME is never a legitimate step.";
  }
  return null;
}

/**
 * Bash policy for the PROJECT profile (spec 0140): the universal clauses, and
 * nothing else — git mutations and file writes are the work, in a checkout
 * that exists for this project's branch.
 *
 * NOT a sandbox, and the spec says so: with `Bash` available, a shell can
 * write wherever the service user can. The real boundaries are the
 * unprivileged user, the scrubbed env (0069), the per-turn audit row (0075),
 * and membership (0135) — a container is the follow-up.
 */

/**
 * Absolute, lexically-resolved paths mentioned by a shell command (spec 0230).
 *
 * The rule this feeds used to compare the command TEXT against a literal root,
 * and 7 of 11 path variations walked past it — measured 2026-08-24, table in the
 * spec. Two of them were not evasion: `cd <own> && ls ../<other>` and
 * `find /srv/launchpad …` are what an agent exploring a tree writes on its own.
 *
 * What each step is for, since each one is a variation that got through:
 * - quotes stripped ANYWHERE in the token, not just around it — `/a/"b"/c`
 * - `VAR=/path` yields the value, or `S=/srv/…; ls $S/x` loses its only clue
 * - `~` expanded, and here that matters more than usual: the service user's home
 *   IS `/srv/launchpad`, the parent of the specs root, so `ls ~/specs/` is a
 *   direct hit rather than a curiosity
 * - `path.posix.normalize` collapses `//` and resolves `.` and `..`
 *
 * Deliberately NOT handled, and the spec says so rather than leaving it to be
 * discovered: globs, and any path built at runtime (`eval`, a variable computed
 * from other values, an intermediate script). A string analysis over shell
 * cannot be a security boundary; this is a guard rail against the accident.
 */
function absolutePathTokens(command: string, home: string): string[] {
  const out: string[] = [];
  for (const raw of (command ?? "").split(/[\s;|&()<>]+/)) {
    if (!raw) continue;
    // `VAR=/srv/...` — take the value, which is the path.
    const assigned = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(raw);
    let token = assigned ? assigned[1]! : raw;
    token = token.replace(/["'`]/g, "");
    if (!token) continue;
    if (token === "~" || token.startsWith("~/")) {
      if (!home) continue; // No HOME: the `~` clause is lost, the rest still holds.
      token = home + token.slice(1);
    }
    if (!token.startsWith("/")) continue;
    out.push(posix.normalize(token).replace(/\/+$/, "") || "/");
  }
  return out;
}

/** Is `child` the same path as `parent`, or underneath it? */
function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Spec 0141 puts every project's specs under ONE root, so a chat scoped to one
 * project could read them all. Observed on the first real project chat: asked
 * to draft a spec for `taqueria-sol-conectada`, it ran
 * `ls -la /srv/launchpad/specs/` and then `ls -la /srv/launchpad/specs/floreria-bella/`
 * — learning the format from another customer's work, and incidentally listing
 * every tenant we host.
 *
 * `ownSpecsDir` is the AUTHORITATIVE value the session was given (the same one
 * `projectScopeBlock` names and `writeTargetDenial` treats as a write root), not
 * a slug re-derived from a path.
 *
 * Honest about its own strength, like the rest of this file: it is a guard rail
 * on the obvious paths, not isolation. `Bash` can still reach the directory by
 * an aliased or constructed path. The real fix is per-project filesystem
 * scoping; this stops the accident and makes the intent explicit.
 */
export function foreignSpecsDenial(
  command: string,
  ownSpecsDir: string | undefined,
  /** Defaults to the process HOME. An unset HOME loses ONLY the `~` clause —
   *  every absolute path still resolves — and a test asserts that degradation
   *  rather than leaving it to be discovered. */
  home: string = process.env["HOME"] ?? "",
): string | null {
  const own = (ownSpecsDir ?? "").trim().replace(/\/+$/, "");
  if (!own) return null;
  const cut = own.lastIndexOf("/");
  if (cut <= 0) return null;
  const root = own.slice(0, cut);

  const tokens = absolutePathTokens(command, home);

  for (const target of tokens) {
    // The root itself: listing it enumerates every tenant we host, which is how
    // this rule came to exist (spec 0141).
    if (target === root) {
      return (
        `denied: ${root} holds EVERY project's specs. Listing it exposes the ` +
        `other tenants. Your project's specs are in ${own}.`
      );
    }
    // Inside the specs root but outside this chat's own directory.
    if (isWithin(root, target) && !isWithin(own, target)) {
      const segment = target.slice(root.length + 1).split("/")[0] ?? "";
      return (
        `denied: ${root}/${segment} belongs to another project. This chat is ` +
        `scoped to ${own} — read your own specs, and the checkout, not a ` +
        `neighbour's.`
      );
    }
    // A strict ANCESTOR of the root (spec 0230). `find /srv/launchpad -name '*.md'`
    // reaches every tenant without ever naming the specs directory, and it is an
    // ordinary thing for an agent to write. Note the service user's home is the
    // root's parent, so `~` lands here too.
    if (root.startsWith(`${target}/`)) {
      return (
        `denied: ${target} is above ${root}, so reading or searching it reaches ` +
        `every project's specs. This chat is scoped to ${own} and its checkout.`
      );
    }
  }

  // `cd` into the specs area, then a relative hop out of it (spec 0230). Both
  // conditions are required, so an ordinary `cd sub && ls ../other` elsewhere in
  // the checkout is untouched — this fires only when the working directory has
  // been moved INSIDE the specs tree.
  const movedIntoSpecs = tokens.some((t) => isWithin(root, t));
  if (movedIntoSpecs && /(?:^|[\s;|&(])cd\s/.test(command ?? "")) {
    const escapesRelatively = (command ?? "")
      .split(/[\s;|&()<>]+/)
      .some((raw) => {
        const token = raw.replace(/["'`]/g, "");
        return token !== "" && !token.startsWith("/") && /(?:^|\/)\.\.(?:\/|$)/.test(token);
      });
    if (escapesRelatively) {
      return (
        `denied: this command changes directory inside ${root} and then steps ` +
        `out with \`..\`, which lands in another project. Address your own ` +
        `specs at ${own} by their full path.`
      );
    }
  }

  return null;
}

export function projectChatBashDenial(
  command: string,
  /** REQUIRED position (the value may be undefined): a caller that does not
   *  think about specs scoping cannot silently skip it. */
  ownSpecsDir: string | undefined,
): string | null {
  const universal = universalBashDenial(command);
  if (universal) return universal;
  const foreign = foreignSpecsDenial(command, ownSpecsDir);
  if (foreign) return foreign;
  // Spec 0173 B. Spec 0140 allowed git mutations here — "git mutations and file
  // writes are the work". The first live A/B run showed what that buys: asked to
  // draft a spec and run the pipeline, the chat drafted the spec, implemented
  // both halves itself, and committed to the branch. No gate 1, no CI, no PR, no
  // gate 2 — and it never pushed, so the work sat in one checkout while the UI
  // said nothing. A chat that can commit is a second, ungated way for code to
  // reach a branch, in a product whose whole claim is that there is one.
  //
  // Writes stay allowed: drafting the spec and preparing files is the job. What
  // changes is that nothing becomes history except through a run.
  if (GIT_MUTATING_RE.test(command ?? "")) {
    return (
      "denied: a chat drafts the spec and STARTS the run — it does not commit. " +
      "Code reaches a branch through the pipeline, where CI, a PR and two gates " +
      "are waiting (CLAUDE.md: no spec, no code). Write the spec, then start the run."
    );
  }
  return null;
}

/**
 * Path confinement for `Write`/`Edit` in the project profile (spec 0140
 * decision 3): the target must resolve INSIDE `root`. `resolve` is injected so
 * the caller can pass a realpath-based resolver (the run worktrees symlink
 * `specs/`, so a lexical check alone would refuse a legitimate write or admit
 * a link that escapes).
 *
 * Returns the denial reason or `null`. A missing/blank path is denied: a write
 * whose target we cannot see is a write we cannot confine.
 */
export function writeTargetDenial(
  root: string,
  target: string | undefined,
  resolve: (p: string) => string,
): string | null {
  const path = (target ?? "").trim();
  if (!path) return "denied: a write needs an explicit file path.";
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(path);
  const inside =
    resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}/`);
  if (!inside) {
    return (
      `denied: ${path} is outside this project's checkout (${resolvedRoot}). ` +
      "A project chat writes only inside its own repository."
    );
  }
  return null;
}
