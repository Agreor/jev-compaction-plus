#!/usr/bin/env bash
# Merge every open PR labelled `ship`, oldest first. Each PR is rebased on the
# latest main and gated before it merges, so two PRs cannot break main together.
set -uo pipefail
git config user.name ship-bot
git config user.email ship-bot@users.noreply.github.com
gh label create ship-blocked --color B60205 --force >/dev/null 2>&1 || true

block() {  # $1 PR number, $2 reason, $3 log file
  gh pr edit "$1" --remove-label ship --add-label ship-blocked >/dev/null
  {
    echo "Ship bot stopped: $2."
    echo "Fix the branch, then add the \`ship\` label again."
    echo
    echo '```'
    tail -n 40 "$3"
    echo '```'
  } > "$RUNNER_TEMP/ship-comment.md"
  gh pr comment "$1" --body-file "$RUNNER_TEMP/ship-comment.md" >/dev/null
}

# Returns 0 when merged, 1 when blocked, 2 when main moved and the PR must be retried.
ship_one() {  # $1 PR number, $2 log file
  local pr=$1 log=$2 head sha
  head=$(gh pr view "$pr" --json headRefName --jq .headRefName) || { block "$pr" "the PR could not be read" "$log"; return 1; }
  if ! { git fetch -q origin main "$head" && git checkout -q -B "$head" "origin/$head"; } >"$log" 2>&1; then
    block "$pr" "the fetch or checkout failed" "$log"; return 1
  fi
  base=$(git rev-parse origin/main)
  if ! git rebase origin/main >"$log" 2>&1; then
    git rebase --abort
    block "$pr" "the rebase on main has a conflict" "$log"; return 1
  fi
  if ! bash scripts/ci-gates.sh >"$log" 2>&1; then
    result=$(grep -E '^RESULT (PASS|FAIL) [0-9]+ file' "$log" | tail -n 1)
    [ -z "$result" ] || echo "#$pr $result"
    block "$pr" "a gate failed" "$log"; return 1
  fi
  result=$(grep -E '^RESULT (PASS|FAIL) [0-9]+ file' "$log" | tail -n 1)
  [ -z "$result" ] || echo "#$pr $result"
  sha=$(git rev-parse HEAD)
  if ! git push --force-with-lease="$head:origin/$head" origin "HEAD:$head" >"$log" 2>&1; then
    # A GITHUB_TOKEN cannot push rewritten commits that touch .github/workflows.
    block "$pr" "the push failed (a PR that changes .github/workflows needs a manual rebase)" "$log"; return 1
  fi
  # ponytail: poll up to 30 s for GitHub to see the pushed head before merging.
  for _ in $(seq 1 15); do
    [ "$(gh pr view "$pr" --json headRefOid --jq .headRefOid)" = "$sha" ] && break
    sleep 2
  done
  # --match-head-commit pins the head only; also make sure main is the base that was gated.
  [ "$(git ls-remote origin refs/heads/main | cut -f1)" = "$base" ] || return 2
  if ! gh pr merge "$pr" --squash --match-head-commit "$sha" >"$log" 2>&1; then
    block "$pr" "the merge failed" "$log"; return 1
  fi
  git push -q origin --delete "$head" >/dev/null 2>&1 || true
  echo "merged #$pr at $sha"
}

status=0
prs=$(gh pr list --label ship --base main --state open \
  --json number,isCrossRepository \
  --jq 'sort_by(.number)[] | select(.isCrossRepository | not) | .number')
for pr in $prs; do
  log=$(mktemp)
  for attempt in 1 2 3; do
    ship_one "$pr" "$log"; result=$?
    [ "$result" -ne 2 ] && break
    echo "main moved while #$pr was gated; retry $attempt"
  done
  [ "$result" -eq 2 ] && { echo "main kept moving" >"$log"; block "$pr" "main kept moving during the gates" "$log"; }
  [ "$result" -ne 0 ] && status=1
done
exit "$status"
