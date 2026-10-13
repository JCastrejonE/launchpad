import { test } from "node:test";
import assert from "node:assert/strict";
import {
  supervisorBashDenial,
  projectChatBashDenial,
  foreignSpecsDenial,
  writeTargetDenial,
} from "./supervisor-tool-policy.js";

/** The specs dir a project chat is actually given (spec 0141). */
const OWN_SPECS = "/srv/launchpad/specs/taqueria-sol";

// spec 0070 / SPEC-ALIGNMENT §10.B (audit #4): the supervisor's "inspect/steer
// only, human-only gate signal, no writes" invariant is now mechanical. These
// pin the pure deny-decision.

const ALLOWED = [
  "git status",
  "git log --oneline -5",
  "git diff HEAD~1 -- packages/pipeline",
  "git show HEAD",
  "cat specs/0032-foo.md",
  "grep -rn TODO packages/ 2>/dev/null",
  "ls -la apps/web",
  "node packages/pipeline/dist/cli.js status 0032", // status is read-only
  "pnpm -r test",
  "git log --format='%h -> %s'", // the `->` must NOT be read as a redirect
  "echo hi > /dev/null", // discard, not a file write
  "grep foo bar.txt 2>&1", // fd dup, not a file write
  "cat /usr/bin/tee", // 'tee' as a path arg, not a command
];

const DENIED = [
  "node packages/pipeline/dist/cli.js promote 0032 owner@example.com",
  "node packages/pipeline/dist/cli.js approve-spec 0032 x",
  "launchpad-pipeline approve-pr 0032 x",
  "node dist/cli.js start 0099 'do a thing'",
  "node packages/pipeline/dist/cli.js reject 0032 x 'nope'",
  "temporal workflow signal --workflow-id spec-0032 --name promote",
  "git push origin main",
  "git commit -m 'x'",
  "git reset --hard HEAD~1",
  "git rebase main",
  "echo pwned > /etc/cron.d/x",
  "cat notes >> ~/out.txt",
  "sed -i 's/a/b/' file.ts",
  "ls | tee out.txt",
  // chained: a benign read followed by a gate fire must still be denied
  "git status && node packages/pipeline/dist/cli.js promote 0032 x",
];

test("supervisorBashDenial allows read-only inspection commands", () => {
  for (const cmd of ALLOWED) {
    assert.equal(supervisorBashDenial(cmd), null, `should allow: ${cmd}`);
  }
});

test("supervisorBashDenial denies gate/start verbs, temporal signals, mutating git, and writes", () => {
  for (const cmd of DENIED) {
    const denial = supervisorBashDenial(cmd);
    assert.equal(typeof denial, "string", `should deny: ${cmd}`);
    assert.ok((denial as string).startsWith("denied:"), `denial reason for: ${cmd}`);
  }
});

test("supervisorBashDenial tolerates empty / missing command", () => {
  assert.equal(supervisorBashDenial(""), null);
  assert.equal(supervisorBashDenial(undefined as unknown as string), null);
});

// --- Spec 0140: the PROJECT profile ----------------------------------------

test("universal clauses hold in the project profile: gates stay human-only", () => {
  for (const cmd of [
    "node packages/pipeline/dist/cli.js promote 0142 owner",
    "node cli.js approve-spec 0142",
    "temporal workflow signal --workflow-id spec-0142 --name promote",
  ]) {
    assert.ok(projectChatBashDenial(cmd, OWN_SPECS), cmd);
    assert.match(projectChatBashDenial(cmd, OWN_SPECS) ?? "", /ADR-007|human/i, cmd);
  }
});

test("the host is off-limits to a project chat", () => {
  for (const cmd of [
    "sudo systemctl restart launchpad-web",
    "systemctl status launchpad-worker",
    "docker ps",
    "ssh root@203.0.113.20 ls",
    "chmod 777 /srv",
  ]) {
    assert.ok(projectChatBashDenial(cmd, OWN_SPECS), cmd);
  }
});

test("secrets and host config are unreadable, whatever verb asks", () => {
  for (const cmd of [
    "cat /etc/launchpad/launchpad.env",
    "grep TOKEN .env",
    "cat ~/.git-credentials",
    "cat ~/.ssh/id_ed25519",
  ]) {
    assert.ok(projectChatBashDenial(cmd, OWN_SPECS), cmd);
    assert.match(projectChatBashDenial(cmd, OWN_SPECS) ?? "", /secret|credential/i, cmd);
  }
});

test("a catastrophic recursive delete is refused", () => {
  assert.ok(projectChatBashDenial("rm -rf /", OWN_SPECS));
  assert.ok(projectChatBashDenial("rm -rf ~", OWN_SPECS));
});

// The whole point of the profile: the work a project chat exists to do is
// allowed, where the inspect console refuses it. Spec 0173 B narrowed what
// that work IS — writing, yes; committing, no.
test("file writes are ALLOWED in the project profile", () => {
  for (const cmd of [
    "cat > specs/hola_mundo.md <<'MD'\n# spec\nMD",
    "sed -i 's/a/b/' hola_mundo/__manifest__.py",
    "mkdir -p hola_mundo && touch hola_mundo/__init__.py",
    // Reading git is how a chat orients itself, and must stay allowed.
    "git status --porcelain",
    "git log --oneline -10",
    "git diff HEAD~1",
  ]) {
    assert.equal(projectChatBashDenial(cmd, OWN_SPECS), null, cmd);
  }
});

/**
 * Spec 0173 B, paid for live: asked to draft a spec and run the pipeline, the
 * project chat drafted the spec, implemented both halves itself, and committed
 * to the branch. No gate 1, no CI, no PR, no gate 2 — and it never pushed, so
 * the work sat in one checkout while the UI said nothing.
 */
test("spec 0173: a project chat may NOT commit — code lands through a run", () => {
  for (const cmd of [
    "git add -A && git commit -m 'feat: menu'",
    "git push origin owner/menu-sushi",
    "git merge main",
    "git rebase origin/main",
    "git cherry-pick 6f9a317",
  ]) {
    const denial = projectChatBashDenial(cmd, OWN_SPECS);
    assert.ok(denial, `must be denied: ${cmd}`);
    // The refusal has to say what to do instead, or the agent just retries.
    assert.match(denial ?? "", /pipeline|run/i, cmd);
  }
});

// The profiles must genuinely DIFFER, or "project" is a relabelled console.
// Asserted only for commands the inspect deny-list actually covers — `mkdir`
// and `touch` are NOT among them (it targets sed -i/tee/dd and redirects), a
// pre-existing gap recorded in 0140's handoff rather than widened here.
test("the same commands the project profile allows are refused by inspect", () => {
  for (const cmd of [
    "git push origin owner/hola-addon",
    "cat > specs/hola_mundo.md <<'MD'\n# spec\nMD",
    "sed -i 's/a/b/' hola_mundo/__manifest__.py",
  ]) {
    assert.ok(supervisorBashDenial(cmd), `inspect must still refuse: ${cmd}`);
  }
});

// --- write confinement ------------------------------------------------------

const idResolve = (p: string) => (p.startsWith("/") ? p.replace(/\/+$/, "") : `/srv/checkout/${p}`);

test("a write inside the checkout is allowed; outside is refused", () => {
  const root = "/srv/checkout";
  assert.equal(writeTargetDenial(root, "/srv/checkout/specs/x.md", idResolve), null);
  assert.equal(writeTargetDenial(root, "specs/x.md", idResolve), null);
  for (const outside of ["/etc/passwd", "/srv/launchpad/repo/CLAUDE.md", "/srv/checkout-other/x"]) {
    const denial = writeTargetDenial(root, outside, idResolve);
    assert.ok(denial, outside);
    assert.match(denial ?? "", /outside this project's checkout/);
  }
});

test("a sibling directory sharing the root's prefix is NOT inside it", () => {
  // "/srv/checkout-other" starts with "/srv/checkout" as a STRING; the check
  // compares path segments, so it must refuse.
  assert.ok(writeTargetDenial("/srv/checkout", "/srv/checkout-other/x", idResolve));
});

test("a write with no path is refused rather than guessed at", () => {
  assert.ok(writeTargetDenial("/srv/checkout", undefined, idResolve));
  assert.ok(writeTargetDenial("/srv/checkout", "   ", idResolve));
});

/**
 * Spec 0174: the prompt has to move with the tool, or the tool sits unused next
 * to an instruction not to use it — which is exactly what the two live sessions
 * did. Asserted on the shipped string, not on intent.
 */
test("spec 0174: the project prompt names the start tool and forbids implementing", async () => {
  const { buildProjectScopeBlockForTest } = await import("./supervisor-session.js");
  const block = buildProjectScopeBlockForTest("/srv/checkouts/sushi", "/srv/specs/sushi");
  assert.match(block, /mcp__forge__start_pipeline/, "the tool must be named, not implied");
  // Spec 0179: a track-1 spec executed by a run makes the spec page print
  // "sin corrida ni gates" beneath a live workflow and its gate buttons.
  assert.match(block, /track: 2/);
  assert.match(block, /no implementes|Do not implement/i);
  assert.match(block, /no commit|do not commit/i);
  // The gates stay human-only, and `start` is no longer lumped in with them.
  assert.match(block, /approve-spec/);
  assert.doesNotMatch(block, /approve-spec \/ approve-pr \/ promote \/ reject \/ start/);
});

// --- specs scoping: one root holds every project (spec 0141) ----------------
// Found live: a chat scoped to taqueria-sol-conectada ran `ls -la
// /srv/launchpad/specs/` and then read floreria-bella's specs.

test("a chat may read its OWN specs directory", () => {
  assert.equal(foreignSpecsDenial(`ls -la ${OWN_SPECS}`, OWN_SPECS), null);
  assert.equal(foreignSpecsDenial(`cat ${OWN_SPECS}/0001-algo.md`, OWN_SPECS), null);
  assert.equal(projectChatBashDenial(`ls ${OWN_SPECS}/`, OWN_SPECS), null);
});

test("a chat may NOT read another project's specs", () => {
  const d = foreignSpecsDenial("ls -la /srv/launchpad/specs/floreria-bella/", OWN_SPECS);
  assert.ok(d, "the observed command must be denied");
  assert.match(d ?? "", /another project/i);
  assert.ok(projectChatBashDenial("cat /srv/launchpad/specs/sushi/0002-x.md", OWN_SPECS));
});

test("a chat may NOT list the specs root — that enumerates every tenant", () => {
  const d = foreignSpecsDenial("ls -la /srv/launchpad/specs/", OWN_SPECS);
  assert.ok(d);
  assert.match(d ?? "", /EVERY project/i);
  assert.ok(foreignSpecsDenial("ls /srv/launchpad/specs", OWN_SPECS));
});

test("without a specs dir there is nothing to scope against, and it says so by allowing", () => {
  // The platform profile has no per-project specs dir. Denying everything here
  // would break the platform chat; the honest behaviour is no opinion.
  assert.equal(foreignSpecsDenial("ls /srv/launchpad/specs/floreria-bella", undefined), null);
});

// --- spec 0230: the guard rail compares the RESOLVED path -------------------
//
// Measured 2026-08-24 against the shipped rule: 7 of these 11 walked past it,
// because it matched the command TEXT against a literal root. Each row below is
// one of those variations, with the verdict this change makes true. The two that
// were never evasion -- `cd <own> && ls ..` and `find` from the parent -- are the
// reason this was worth doing: they are what an agent exploring a tree writes.
const HOME = "/srv/launchpad"; // the service user's real home: the root's PARENT.

for (const [name, command] of [
  ["a doubled slash", "ls -la /srv/launchpad//specs/floreria-bella/"],
  ["`..` out of the own directory, absolute", `ls -la ${OWN_SPECS}/../floreria-bella/`],
  ["`cd` into the own directory, then `..`", `cd ${OWN_SPECS} && ls -la ../floreria-bella`],
  ["quotes splitting the path", 'ls -la /srv/launchpad/"specs"/floreria-bella/'],
  ["`find` from a directory ABOVE the root", "find /srv/launchpad -name '*.md'"],
  ["a home-relative path", "ls -la ~/../launchpad/specs/floreria-bella/"],
  ["`~` straight at the root, since HOME is its parent", "ls -la ~/specs/"],
] as const) {
  test(`spec 0230: denied -- ${name}`, () => {
    const d = foreignSpecsDenial(command, OWN_SPECS, HOME);
    assert.ok(d, `expected a denial for: ${command}`);
    assert.match(d, /denied:/);
  });
}

test("spec 0230: the four that already worked keep working", () => {
  for (const command of [
    "ls -la /srv/launchpad/specs/floreria-bella/",
    "cd /srv/launchpad/specs && ls -la floreria-bella",
    "S=/srv/launchpad/specs; ls -la $S/floreria-bella",
    "ln -s /srv/launchpad/specs /tmp/x && ls -la /tmp/x/floreria-bella",
  ]) {
    assert.ok(foreignSpecsDenial(command, OWN_SPECS, HOME), `regressed: ${command}`);
  }
});

test("spec 0230: the project's own work is NOT denied", () => {
  for (const command of [
    `ls -la ${OWN_SPECS}/`,
    `cat ${OWN_SPECS}/0001-algo.md`,
    "ls -la . && cat README.md",
    "cd apps/web && ls ../../packages", // `..` outside the specs tree stays fine
    "ls -la /tmp",
  ]) {
    assert.equal(foreignSpecsDenial(command, OWN_SPECS, HOME), null, `false positive: ${command}`);
  }
});

test("spec 0230: a glob still gets through, and this test SAYS so", () => {
  // Not an oversight -- the spec defers it. A glob would need pattern-to-regex
  // expansion for a case nobody reaches by accident: writing `spec?` is already
  // probing the rail. Recorded as a test so the gap is a decision on the record
  // rather than something a reader has to notice is missing.
  assert.equal(
    foreignSpecsDenial("ls -la /srv/launchpad/spec?/floreria-bella/", OWN_SPECS, HOME),
    null,
  );
});

test("spec 0230: an unset HOME loses ONLY the tilde clause", () => {
  // Honest degradation, asserted rather than assumed: every absolute path still
  // resolves when HOME is missing, and only `~` stops being expandable.
  assert.ok(foreignSpecsDenial("ls /srv/launchpad/specs/floreria-bella/", OWN_SPECS, ""));
  assert.equal(foreignSpecsDenial("ls ~/specs/", OWN_SPECS, ""), null);
});
