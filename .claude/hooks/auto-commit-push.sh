#!/usr/bin/env bash
# Claude Code hook: commit and push pending changes once per 10 minutes of coding activity.
# Wired to PostToolUse (Write|Edit|NotebookEdit) and Stop in .claude/settings.local.json.
# Override the interval with AUTO_COMMIT_INTERVAL (seconds).

INTERVAL="${AUTO_COMMIT_INTERVAL:-600}"

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
git_dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0

stamp="$git_dir/claude-autocommit-stamp"
lock="$git_dir/claude-autocommit.lock"
log="$git_dir/claude-autocommit.log"

# Never commit in the middle of a merge, rebase or cherry-pick.
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  [ -e "$git_dir/$marker" ] && exit 0
done

# Nothing to commit: leave the clock alone.
[ -z "$(git status --porcelain)" ] && exit 0

now=$(date +%s)

# First change of a work period starts the 10-minute clock.
if [ ! -f "$stamp" ]; then
  echo "$now" > "$stamp"
  exit 0
fi

last=$(cat "$stamp" 2>/dev/null)
case "$last" in ''|*[!0-9]*) last=0 ;; esac
[ $((now - last)) -lt "$INTERVAL" ] && exit 0

# One run at a time (hooks fire in parallel on batched edits).
mkdir "$lock" 2>/dev/null || exit 0
trap 'rmdir "$lock" 2>/dev/null' EXIT

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="
  git add -A &&
    git commit -m "Auto-commit: $(date '+%Y-%m-%d %H:%M')" &&
    git push origin HEAD
  echo "exit: $?"
} >> "$log" 2>&1

# Clock restarts with the next change.
rm -f "$stamp"
exit 0
