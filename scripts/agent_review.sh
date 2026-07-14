#!/usr/bin/env bash
# Cross-model / multi-persona code review driver. See docs/agent-review.md.
#
# The reviewer is deliberately NOT the author: it prefers an external agent CLI
# (codex/cursor-agent/gemini/aider) for true model diversity, and otherwise falls
# back to `claude -p` running on a DIFFERENT model than the one that wrote the code
# (default: sonnet). Install any external CLI and this script uses it automatically.
#
# Usage:
#   scripts/agent_review.sh <stage> [--persona <name>|all] [--diff <ref>]
#   scripts/agent_review.sh --list
#
#   stage: research | plan | implementation | wrap-up
#     research/plan   -> reviews the latest worksheet (or stdin) — the approach
#     implementation  -> reviews `git diff <ref>` (default HEAD) — the code
#     wrap-up         -> reviews the diff + reminds to update docs/tests
#
# Env: REVIEW_MODEL (default: sonnet) — the claude fallback reviewer model.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

REVIEW_MODEL="${REVIEW_MODEL:-sonnet}"

# --- personas: name|lens ---------------------------------------------------
personas_all() {
  cat <<'EOF'
correctness|Find logic bugs, missed cases, and any path where codegen can hit an invalid state the type checker should have caught. Flag UB in `unsafe` blocks.
security|Find memory-safety holes, guard bypasses (never run milo-self.bin bare; never MILO_RUN_UNGUARDED=1), unsafe FFI/ABI mistakes, and injection.
performance|Find needless allocations/copies, algorithmic regressions, and avoidable cost on hot paths. Note anything that would move a benchmark the wrong way.
maintainability|Find unclear names, dead/commented-out code, duplication, over-abstraction. Enforce CONVENTIONS.md (camelCase milo, why-comments only).
ai-smells|Find hallucinated/nonexistent APIs, plausible-but-wrong code, copy-paste errors, comments that lie, and tests that assert nothing meaningful.
testing|Find coverage gaps, false-confidence tests (would still pass if the feature were deleted), and missing error/edge fixtures. See docs/testing.md.
domain|As a compiler/PL expert: check type-system soundness, monomorphization, ABI correctness, and that emitted LLVM IR is valid (opaque ptr, LLVM 15+).
EOF
}

if [ "${1:-}" = "--list" ]; then personas_all | awk -F'|' '{printf "  %-15s %s\n",$1,$2}'; exit 0; fi

stage="${1:-implementation}"; shift || true
persona="all"; diffref="HEAD"
while [ $# -gt 0 ]; do
  case "$1" in
    --persona) persona="$2"; shift 2;;
    --diff)    diffref="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

# --- gather the material under review --------------------------------------
case "$stage" in
  research|plan)
    latest_ws=$(ls -t worksheets/*.md 2>/dev/null | grep -v README | grep -v TEMPLATE | head -1 || true)
    if [ -n "$latest_ws" ]; then material=$(cat "$latest_ws"); src="worksheet $latest_ws";
    elif [ ! -t 0 ]; then material=$(cat); src="stdin";
    else echo "no worksheet found and no stdin — nothing to review" >&2; exit 1; fi
    ;;
  implementation|wrap-up)
    material=$(git diff "$diffref"; git diff --cached)
    src="git diff $diffref"
    [ -z "$material" ] && { echo "no diff against $diffref — nothing to review" >&2; exit 1; }
    ;;
  *) echo "unknown stage: $stage (research|plan|implementation|wrap-up)" >&2; exit 2;;
esac

# --- pick the reviewer -----------------------------------------------------
# External CLIs give a genuinely different model; claude fallback uses a
# different model than the author. Extend this as you install tools.
run_reviewer() { # $1 = full prompt (on stdin)
  if command -v codex >/dev/null 2>&1;        then codex exec -;      return; fi
  if command -v cursor-agent >/dev/null 2>&1; then cursor-agent -p -; return; fi
  if command -v gemini >/dev/null 2>&1;       then gemini -p "$(cat)"; return; fi
  if command -v aider >/dev/null 2>&1;        then aider --message "$(cat)" --no-auto-commits; return; fi
  claude -p --model "$REVIEW_MODEL"
}

reviewer_name() {
  for c in codex cursor-agent gemini aider; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; return; }; done
  echo "claude ($REVIEW_MODEL)"
}

echo "== agent review: stage=$stage  reviewer=$(reviewer_name)  source=$src =="
if [ "$reviewer_name" = "claude ($REVIEW_MODEL)" ] && [ "$REVIEW_MODEL" = "opus" ]; then
  echo "WARNING: reviewer model == likely author model. Set REVIEW_MODEL to a different model." >&2
fi

selected=$(personas_all | { [ "$persona" = "all" ] && cat || grep -i "^$persona|"; })
[ -z "$selected" ] && { echo "no such persona: $persona (try --list)" >&2; exit 2; }

echo "$selected" | while IFS='|' read -r name lens; do
  [ -z "$name" ] && continue
  echo
  echo "----- persona: $name -----"
  prompt=$(cat <<EOF
You are a $name reviewer for the Milo compiler (memory-safe systems language -> LLVM IR, TypeScript compiler on Bun). You did NOT write this code; review it adversarially.

Your lens: $lens

Read the material below. Report ONLY concrete, actionable findings for your lens — file:line, the problem, and the fix. If you find nothing real, say "no $name findings". Do not restate the diff. Be terse.

Repo conventions: see CONVENTIONS.md. Milo identifiers are camelCase. Semantic errors belong in checker.ts before codegen.

--- MATERIAL ($src) ---
$material
EOF
)
  printf '%s' "$prompt" | run_reviewer || echo "(reviewer failed for persona $name)"
done
