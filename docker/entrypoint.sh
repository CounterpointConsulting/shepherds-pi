#!/bin/bash
set -euo pipefail

# ─── Security: never expose secrets in argv, env to children, or on disk ─

# Prevent git from prompting for credentials interactively.
export GIT_TERMINAL_PROMPT=0

# Route all git credential requests through our askpass helper, which reads
# from the tmpfs-mounted /run/secrets/git_token. The token is NEVER placed
# into clone URLs or .git/config.
export GIT_ASKPASS=/usr/local/bin/git-askpass.sh

# ─── Environment variables (passed by Orchestrator) ─────────────────────
#   REPO_MODE            - clone | mounted
#   GIT_OPS_MODE         - container | host
#   GIT_URL              - clean repository URL (for clone mode)
#   BRANCH_NAME          - branch to checkout (defaults to "dev")
#   PERSONA_DIR          - path to persona config mount (default: /persona)
#   INSTRUCTIONS_FILE    - path to instructions file mount
#   CONTEXT_FILE         - path to context file mount
#   MODEL                - model ID (e.g., openrouter/anthropic/claude-sonnet-4)
#
# Secrets are read from tmpfs, never from env:
#   /run/secrets/git_token       - GitHub PAT (needed for clone or container push)
#   /run/secrets/openrouter_key  - OpenRouter API key

REPO_MODE="${REPO_MODE:-clone}"
GIT_OPS_MODE="${GIT_OPS_MODE:-container}"
BRANCH_NAME="${BRANCH_NAME:-dev}"

echo "=== Shepherds Pi Agent ===" >&2
echo "Persona:   ${PERSONA_DIR:-/persona}" >&2
echo "Model:     ${MODEL:-unknown}" >&2
echo "Branch:    ${BRANCH_NAME}" >&2
echo "Repo mode: ${REPO_MODE}" >&2
echo "Git ops:   ${GIT_OPS_MODE}" >&2

prepare_repo_clone() {
  if [ -z "${GIT_URL:-}" ]; then
    echo '{"type":"error","message":"GIT_URL not set (required for clone mode)"}' >&2
    exit 1
  fi

  if [ ! -r /run/secrets/git_token ]; then
    echo '{"type":"error","message":"No git token mounted at /run/secrets/git_token (required for clone mode)"}' >&2
    exit 1
  fi

  echo "Cloning ${BRANCH_NAME} from ${GIT_URL}..." >&2

  # Git will call GIT_ASKPASS for credentials. The URL stays clean — no
  # token embedded — so .git/config after clone contains only $GIT_URL.
  CLONE_ERR=$(git clone --branch "$BRANCH_NAME" --single-branch --depth 50 "$GIT_URL" /workspace/repo 2>&1) || {
    echo "Single-branch clone failed: $CLONE_ERR" >&2
    echo "Trying full clone..." >&2
    CLONE_ERR2=$(git clone --depth 50 "$GIT_URL" /workspace/repo 2>&1) || {
      echo "Clone failed: $CLONE_ERR2" >&2
      echo '{"type":"error","message":"git clone failed — check GIT_TOKEN and repo access"}' >&2
      exit 1
    }
    cd /workspace/repo
    if ! git checkout "$BRANCH_NAME" 2>/dev/null; then
      git checkout -b "$BRANCH_NAME"
    fi
  }

  cd /workspace/repo

  # Belt-and-suspenders: verify no credential ended up in the remote URL.
  CURRENT_REMOTE=$(git remote get-url origin)
  case "$CURRENT_REMOTE" in
    *@*)
      echo "WARNING: remote URL contains credentials, rewriting to clean URL" >&2
      git remote set-url origin "$GIT_URL"
      ;;
  esac
}

prepare_repo_mounted() {
  if [ ! -d /workspace/repo ]; then
    echo '{"type":"error","message":"Mounted repo mode requested, but /workspace/repo is missing"}' >&2
    exit 1
  fi

  cd /workspace/repo
  echo "Using mounted repository at /workspace/repo" >&2
}

# ─── 1. Prepare repository ───────────────────────────────────────

case "$REPO_MODE" in
  clone)
    prepare_repo_clone
    ;;
  mounted)
    prepare_repo_mounted
    ;;
  *)
    echo "{\"type\":\"error\",\"message\":\"Unsupported REPO_MODE: $REPO_MODE\"}" >&2
    exit 1
    ;;
esac

# ─── 2. Configure git identity (container git mode only) ────────

if [ "$GIT_OPS_MODE" = "container" ]; then
  if [ ! -e .git ]; then
    echo '{"type":"error","message":"Container git mode requires a git repository at /workspace/repo"}' >&2
    exit 1
  fi

  git config user.name "Shepherds Pi Agent"
  git config user.email "agent@shepherds-pi.dev"

  CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
  if [ -z "$CURRENT_BRANCH" ]; then
    CURRENT_BRANCH="detached"
  fi
  echo "Checked out: $(git rev-parse --short HEAD) on ${CURRENT_BRANCH}" >&2
else
  echo "Host-managed git mode: skipping in-container git identity/setup." >&2
fi

# ─── 3. Determine model ─────────────────────────────────────────

if [ -n "${MODEL:-}" ]; then
  MODEL_ARG="$MODEL"
elif [ -f "${PERSONA_DIR:-/persona}/model.txt" ]; then
  MODEL_ARG=$(cat "${PERSONA_DIR:-/persona}/model.txt")
else
  MODEL_ARG="openrouter/anthropic/claude-sonnet-4"
fi

# ─── 4. Load OpenRouter API key from tmpfs into env for pi ──────

if [ ! -r /run/secrets/openrouter_key ]; then
  echo '{"type":"error","message":"No OpenRouter key mounted at /run/secrets/openrouter_key"}' >&2
  exit 1
fi

# pi reads OPENROUTER_API_KEY from env — this is the one place the key
# has to live as an env var (for pi's process). It is NOT passed on the
# command line (which would appear in `ps`), and it is NOT set in the
# container's Docker Env (which would appear in `docker inspect`).
OPENROUTER_API_KEY="$(cat /run/secrets/openrouter_key)"
export OPENROUTER_API_KEY

# ─── 5. Build pi command ────────────────────────────────────────

PI_ARGS=()
PI_ARGS+=("--mode" "json")
PI_ARGS+=("--model" "$MODEL_ARG")
# NOTE: --api-key deliberately omitted — pi reads OPENROUTER_API_KEY from env.

PERSONA_DIR="${PERSONA_DIR:-/persona}"

if [ -f "$PERSONA_DIR/SYSTEM.md" ]; then
  PI_ARGS+=("--append-system-prompt" "$PERSONA_DIR/SYSTEM.md")
fi

INSTRUCTIONS=""
if [ -f "${INSTRUCTIONS_FILE:-/tmp/instructions.txt}" ]; then
  INSTRUCTIONS=$(cat "${INSTRUCTIONS_FILE:-/tmp/instructions.txt}")
fi

if [ -s "${CONTEXT_FILE:-/tmp/context.txt}" ]; then
  PI_ARGS+=("--append-system-prompt" "${CONTEXT_FILE:-/tmp/context.txt}")
fi

if [ -d "$PERSONA_DIR/skills" ]; then
  for skill_dir in "$PERSONA_DIR/skills"/*/; do
    if [ -d "$skill_dir" ] && [ -f "$skill_dir/SKILL.md" ]; then
      PI_ARGS+=("--skill" "$skill_dir/SKILL.md")
    fi
  done
fi

# Load shared meta-skill if mounted by the spawner.
if [ -f "/shared-skills/using-agent-skills/SKILL.md" ]; then
  PI_ARGS+=("--skill" "/shared-skills/using-agent-skills/SKILL.md")
fi

if [ "$GIT_OPS_MODE" = "host" ]; then
  GIT_REMINDER="Host-managed git mode is active. Do NOT run git commands (especially commit/push/merge/status/diff) in this container. The host will finalize all git operations after you complete the task."
  GIT_ENV_NOTE="- Git: HOST-MANAGED. Do NOT run any git command. In particular, \`.git\` here may be a worktree pointer to a host path that does not exist in this container, so \`git status\`, \`git diff\`, \`git merge\`, \`git log\`, etc. will fail or mislead. Just read/edit/create files in the working tree; the host commits, pushes, and merges for you. To see what changed, compare files directly (e.g. \`rg\`, reading files) instead of \`git diff\`."
else
  GIT_REMINDER="Then commit and push any code changes to the current branch with an appropriate commit message."
  GIT_ENV_NOTE="- Git: CONTAINER-MANAGED. You own git in this container. Commit and push your changes to the current branch when done. A credential helper is preconfigured; do not embed tokens in URLs."
fi

# Standing environment brief, injected once for every persona so agents do not
# waste tool calls rediscovering the sandbox. Keep this factual and current with
# docker/Dockerfile.
ENV_BRIEF="RUNTIME ENVIRONMENT (read before exploring — this is your sandbox):
- OS: Debian 12 (bookworm) Linux container, non-root user (uid 1000). You ARE the sandbox; it is disposable.
- Working directory: your repository is at /workspace/repo (this is your CWD). Do your work there.
- Filesystem: rootfs is READ-ONLY. Writable paths are /workspace (your repo + scratch), /tmp, and /home/node/.pi. Do NOT try to write elsewhere (e.g. global npm installs, /usr, /etc) — it will fail. Prefer project-local installs.
- Runtimes/tools already installed globally (do NOT reinstall): node 20, npm, npx, pnpm 9 (\`pnpm\`), yarn 1 (\`yarn\`), git, ripgrep (\`rg\` — prefer over grep/find for search), jq, curl, psql (postgresql-client), and Playwright + Chromium (browsers at /ms-playwright). Project-local dev tools (e.g. tsx, vite, tsc) come from the repo's own dependencies after install — run them via your package manager scripts or \`npx\`/\`pnpm exec\`, not global installs.
- Network: available for package installs. No OpenAI/vendor keys are present unless explicitly provided; design/verify against mock providers when a key is absent.
- Display: HEADLESS only. Browser automation (Playwright) must run headless; there is no interactive display.
${GIT_ENV_NOTE}
- Package manager: this project uses pnpm (see pnpm-workspace.yaml / packageManager field). Use \`pnpm\` for install/scripts unless the repo clearly uses npm or yarn."

PI_ARGS+=("--append-system-prompt" "$ENV_BRIEF")

SUMMARIZE_REMINDER="IMPORTANT: When you have completed your task (or cannot make further progress), you MUST write /output/result.json using the write tool.

Follow your persona's summarize skill schema exactly. Use camelCase field names (e.g., filesCreated, filesModified, dependsOn, testsPassed, stepsToReproduce) rather than snake_case.

Always include at least:
- status
- summary

${GIT_REMINDER}"

PI_ARGS+=("--append-system-prompt" "$SUMMARIZE_REMINDER")

# ─── 6. Run pi ──────────────────────────────────────────────────

echo "Starting pi with model $MODEL_ARG..." >&2
echo "Instructions: ${INSTRUCTIONS:0:100}..." >&2

if [ -n "$INSTRUCTIONS" ]; then
  pi "${PI_ARGS[@]}" --print "$INSTRUCTIONS" 2>/dev/null | tee /output/events.jsonl
  EXIT_CODE=${PIPESTATUS[0]}
else
  echo '{"type":"error","message":"No instructions provided"}' >&2
  exit 1
fi

echo "Pi exited with code $EXIT_CODE" >&2

# ─── 7. Verify result.json exists (fallback using jq) ───────────

if [ ! -f /output/result.json ]; then
  echo "Warning: /output/result.json not created by agent" >&2

  if [ -f /output/events.jsonl ]; then
    LAST_MSG=$(grep '"message_end"' /output/events.jsonl | tail -1 || true)
    if [ -n "$LAST_MSG" ]; then
      SUMMARY=$(echo "$LAST_MSG" \
        | jq -r '[.message.content[]? | select(.type == "text") | .text] | join(" ") | .[0:500]' \
        2>/dev/null || echo "Agent completed but did not produce a result file")
      ESCAPED_SUMMARY=$(printf '%s' "$SUMMARY" | jq -Rs .)
      echo "{\"status\":\"partial\",\"summary\":$ESCAPED_SUMMARY}" > /output/result.json
    fi
  fi
fi

# ─── 8. Commit and push any changes (container mode only) ───────

if [ "$GIT_OPS_MODE" = "container" ]; then
  cd /workspace/repo
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "feat: agent changes for task" 2>/dev/null || true
  fi

  # Push uses GIT_ASKPASS, so the token is read from tmpfs and never
  # appears in the remote URL or argv.
  git push origin HEAD 2>/dev/null || echo "Warning: push failed" >&2
else
  echo "Host-managed git mode: skipping commit/push in container." >&2
fi

exit $EXIT_CODE
