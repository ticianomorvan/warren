#!/usr/bin/env bash
# Applies Warren's GitHub repository settings. Safe to rerun: every call sets a desired state.
# Usage: scripts/github-settings.sh [owner/repo]   (needs `gh` signed in with admin rights)
#
# Some settings are refused on a private repository without a paid plan (rulesets, secret
# scanning, push protection). Each step reports its own failure and the script continues, so
# rerun it after the repository goes public or the plan changes. Exit status is 1 when any
# step failed.
set -u
REPO="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
failed=0

step() {
  local name="$1"
  shift
  if out=$("$@" 2>&1); then
    echo "ok       $name"
  else
    echo "REFUSED  $name"
    echo "$out" | sed 's/^/           /'
    failed=1
  fi
}

# Squash merge only, with the pull request title as the commit title.
step "merge settings" gh api -X PATCH "repos/$REPO" \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=COMMIT_MESSAGES \
  -F delete_branch_on_merge=true -F allow_auto_merge=true \
  -F web_commit_signoff_required=true

# Secret scanning and push protection.
step "secret scanning + push protection" gh api -X PATCH "repos/$REPO" --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON

# Private vulnerability reporting (the advisory form that SECURITY.md points to).
step "private vulnerability reporting" gh api -X PUT "repos/$REPO/private-vulnerability-reporting"

# Workflows: read-only token by default; Actions may not approve pull requests.
step "workflow permissions" gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# Ruleset on main. The required check names are the job names in .github/workflows
# (ci.yml: check, dco.yml: dco, pr-title.yml: pr-title); they must have run once.
ruleset=$(cat <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "check" },
          { "context": "dco" },
          { "context": "pr-title" }
        ]
      }
    }
  ]
}
JSON
)
apply_ruleset() {
  local id
  id=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name=="main") | .id' | head -n1) || return 1
  if [ -n "$id" ]; then
    echo "$ruleset" | gh api -X PUT "repos/$REPO/rulesets/$id" --input -
  else
    echo "$ruleset" | gh api -X POST "repos/$REPO/rulesets" --input -
  fi
}
step "ruleset on main" apply_ruleset

exit "$failed"
