#!/usr/bin/env bash
#
# The full pre-release gate, as one command.
#
#   bash scripts/release-gate.sh            # everything except the clean room
#   bash scripts/release-gate.sh --full     # adds the Docker clean-room run
#
# Runs: typecheck, build, unit, smoke (free tier), the SIGKILL/respawn e2e, and
# optionally the packaged-artifact clean-room check. Prints one table and exits
# non-zero if any gate fails.
#
# WHY THIS FILE EXISTS
#
# Release day used to be twenty separate approvals: each gate typed as its own
# chained one-liner with env assignments and $(...) substitutions, none of which
# can match a permission rule, so every one prompted. Collapsing the sequence
# into a committed script makes it a single approval — and, more importantly,
# makes the gate a reviewable artifact rather than a sequence someone remembered.
#
# What this script deliberately does NOT do: git tag, git push, npm publish. The
# gate reports; a human releases. That separation is the release discipline, and
# wrapping those commands here would quietly dissolve it.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FULL=0
[[ "${1:-}" == "--full" ]] && FULL=1

declare -a NAMES RESULTS DETAILS
FAILED=0

record() {
  NAMES+=("$1"); RESULTS+=("$2"); DETAILS+=("${3:-}")
  # Only an actual FAIL fails the gate. This once read `[[ "$2" == "pass" ]] ||
  # FAILED=1`, which made a deliberately skipped step report "GATE FAILED — do
  # not release" with every line passing. A gate that cries failure is as
  # useless as one that cries success: both teach the reader to stop reading it.
  [[ "$2" == "FAIL" ]] && FAILED=1
  return 0
}

step() {
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    record "$name" pass "$(printf '%s' "$out" | grep -oE '[0-9]+ passed \([0-9]+\)' | tail -1)"
  else
    record "$name" FAIL "$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
  fi
}

echo "gitmem release gate — version $(node -p "require('./package.json').version")"
echo

step "typecheck"            npm run typecheck
step "build"                npm run build
step "unit"                 npm run test:unit
step "smoke (free tier)"    npm run test:smoke:free
step "e2e restart"          npx vitest run --config vitest.e2e.config.ts tests/e2e/git-89-session-identity.test.ts
step "restart smoke (local)" bash testing/clean-room/verify-against.sh new

if [[ "$FULL" == "1" ]]; then
  step "clean room (packaged)" bash testing/clean-room/verify-against.sh cleanroom
else
  record "clean room (packaged)" skipped "pass --full to include"
fi

echo
printf '%-26s %s\n' "GATE" "RESULT"
printf '%-26s %s\n' "--------------------------" "------"
for i in "${!NAMES[@]}"; do
  printf '%-26s %-8s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}" "${DETAILS[$i]}"
done
echo

if [[ "$FAILED" == "1" ]]; then
  echo "GATE FAILED — do not release."
  exit 1
fi

if [[ "$FULL" != "1" ]]; then
  echo "Gates passed, but the packaged artifact was NOT tested."
  echo "Run with --full before tagging: bash scripts/release-gate.sh --full"
  exit 0
fi

echo "All gates passed on the packaged artifact."
echo "Release is a human step — tagging and publishing are intentionally not scripted."
