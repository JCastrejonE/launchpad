#!/usr/bin/env bash
#
# break-check.sh — prove a guard is real by breaking it and watching it go red
# (build-plan Phase 3, from docs/COMPLIANCE-REGISTRY.md rows 8, 33, 63).
#
# The habit is the highest-yield one in the registry: it caught rows 1, 2 and 3.
# All three of its recorded FAILURES were the harness, never the idea, and all
# three happened in a single day:
#
#   row 8   the break silently did not apply, so a green suite "proved" nothing
#   row 33  restore used `git checkout` — but the fix under test was UNCOMMITTED,
#           so the restore deleted it and the suite failed for the wrong reason
#   row 63  the break produced a TYPE error: exit 2, no tests run. Non-zero
#           looked like red. It was not red, it was "never compiled"
#
# So this script asserts all three:
#   the mutation applied (byte hash changed, and matched EXACTLY once)
#   the suite actually RAN and FAILED (exit 1 and at least one `not ok`)
#   the restore came from a BYTE SNAPSHOT, and the suite is green again after it
#
# Exit codes are deliberately distinct, because "your test is weak" and "my
# harness broke" must never look the same:
#   0  the guard is real
#   1  the break did NOT turn the suite red — the test does not guard this
#   2  harness problem (ambiguous match, compile error, restore failed)
#
# Usage:
#   scripts/break-check.sh --file <path> --from <literal> --to <literal> \
#     [--cmd '<test command>']
#
#   --cmd defaults to `pnpm -r test`; pass a filtered one when you know the
#   package, because a 90-second suite discourages the habit this exists to make
#   cheap.
set -uo pipefail

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '   \033[31mFAIL\033[0m %s\n' "$*"; }
die2() { printf '\n\033[33mHARNESS: %s\033[0m\n' "$*" >&2; exit 2; }

FILE=""; FROM=""; TO=""; CMD="pnpm -r test"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) FILE="${2:-}"; shift 2 ;;
    --from) FROM="${2:-}"; shift 2 ;;
    --to)   TO="${2:-}";   shift 2 ;;
    --cmd)  CMD="${2:-}";  shift 2 ;;
    --) shift ;;
    *) die2 "unknown argument $1" ;;
  esac
done
[[ -n "$FILE" && -n "$FROM" && -n "$TO" ]] || die2 "need --file, --from and --to"
[[ -f "$FILE" ]] || die2 "no such file: $FILE"

SNAP="$(mktemp -t breakcheck-XXXXXX)"
cp "$FILE" "$SNAP"
before_hash="$(shasum -a 256 "$FILE" | cut -d' ' -f1)"

restore() {
  # Row 33: bytes back from the snapshot. `git checkout` restores the COMMITTED
  # content, which deletes an uncommitted fix — exactly the thing under test.
  cp "$SNAP" "$FILE"
  rm -f "$SNAP"
}

say "Applying the mutation"
python3 - "$FILE" "$FROM" "$TO" <<'PY' || { restore; die2 "the mutation could not be applied (see above)"; }
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding="utf-8").read()
n = s.count(frm)
if n == 0:
    print("   the --from text does not appear in the file", file=sys.stderr); sys.exit(1)
if n > 1:
    # An ambiguous mutation tests something other than what you named.
    print(f"   the --from text appears {n} times — be more specific", file=sys.stderr); sys.exit(1)
open(path, "w", encoding="utf-8").write(s.replace(frm, to))
PY
after_hash="$(shasum -a 256 "$FILE" | cut -d' ' -f1)"
if [[ "$before_hash" == "$after_hash" ]]; then
  restore; die2 "the file did not change — a break that did not apply proves nothing (row 8)"
fi
ok "mutation applied, matched exactly once, hash changed"

say "Running: $CMD"
out="$(mktemp -t breakout-XXXXXX)"
# Its OWN status, never a pipe's (VERIFICATION #8).
set +e
eval "$CMD" >"$out" 2>&1
status=$?
set -e
notok="$(grep -c '^not ok' "$out" || true)"
printf '   exit=%s   "not ok" lines=%s\n' "$status" "$notok"

say "Restoring from the byte snapshot"
restore
ok "restored"

# Row 63: exit 2 with zero `not ok` means the suite never ran. That is a harness
# result, not evidence about the guard.
if [[ "$status" -eq 0 ]]; then
  bad "the suite stayed GREEN with the guard broken"
  printf '\n\033[31mNOT GUARDED: nothing failed when %s was mutated.\033[0m\n' "$FILE" >&2
  printf 'Either the test does not cover this, or it asserts the call you make\n' >&2
  printf 'rather than the behaviour (docs/VERIFICATION.md #1).\n' >&2
  rm -f "$out"; exit 1
fi
if [[ "$notok" -eq 0 ]]; then
  bad "non-zero exit ($status) but no test reported failure"
  printf '   last lines:\n'; tail -5 "$out" | sed 's/^/     /'
  rm -f "$out"
  die2 "the suite did not RUN (a compile error is exit 2, and is not red — row 63)"
fi

say "Confirming the restore is green"
set +e
eval "$CMD" >"$out" 2>&1
restored=$?
set -e
if [[ "$restored" -ne 0 ]]; then
  printf '   last lines:\n'; tail -5 "$out" | sed 's/^/     /'
  rm -f "$out"
  die2 "the suite is red AFTER restoring — the snapshot did not put things back"
fi
ok "green again after restore"
rm -f "$out"

printf '\n\033[32mGUARD IS REAL: %s failing test(s) when %s was mutated.\033[0m\n' "$notok" "$FILE"
