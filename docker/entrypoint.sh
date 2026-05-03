#!/bin/bash
set -euo pipefail

# Prevent git from prompting for credentials interactively
export GIT_TERMINAL_PROMPT=0

# ─── Environment variables (passed by Orchestrator) ──────────────
#   GIT_URL            - repository URL (https://github.com/org/repo)
#   GIT_TOKEN          - personal access token for git
#   BRANCH_NAME        - branch to checkout (defaults to "dev")
#   PERSONA_DIR        - path to persona config mount (default: /persona)
#   INSTRUCTIONS_FILE  - path to instructions file mount
#   CONTEXT_FILE       - path to context file mount
#   MODEL              - model ID (e.g., openrouter/anthropic/claude-sonnet-4)
#   OPENROUTER_API_KEY - API key for OpenRouter

echo "=== Shepherds Pi Agent ===" >&2
echo "Persona: ${PERSONA_DIR:-/persona}" >&2
echo "Model:   ${MODEL:-unknown}" >&2
echo "Branch:  ${BRANCH_NAME:-dev}" >&2

# ─── 1. Clone and checkout ──────────────────────────────────────

if [ -z "${GIT_URL:-}" ]; then
  echo '{"type":"error","message":"GIT_URL not set"}' >&2
  exit 1
fi

BRANCH_NAME="${BRANCH_NAME:-dev}"

# Build authenticated URL (GitHub PAT format: https://x-access-token:TOKEN@github.com/...)
if [ -n "${GIT_TOKEN:-}" ]; then
  # Use x-access-token as username per GitHub recommendation
  AUTH_URL=$(echo "$GIT_URL" | sed "s|://|://x-access-token:${GIT_TOKEN}@|")
else
  AUTH_URL="$GIT_URL"
fi

echo "Cloning ${BRANCH_NAME} from ${GIT_URL}..." >&2

# Try cloning the specific branch first
CLONE_ERR=$(git clone --branch "$BRANCH_NAME" --single-branch --depth 50 "$AUTH_URL" /workspace/repo 2>&1) || {
  echo "Single-branch clone failed: $CLONE_ERR" >&2
  # If single-branch fails (branch may not exist), clone all branches
  echo "Trying full clone..." >&2
  CLONE_ERR2=$(git clone --depth 50 "$AUTH_URL" /workspace/repo 2>&1) || {
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

# ─── 2. Configure git identity ──────────────────────────────────

git config user.name "Shepherds Pi Agent"
git config user.email "agent@shepherds-pi.dev"

echo "Checked out: $(git rev-parse --short HEAD) on $(git branch --show-current)" >&2

# ─── 3. Determine model ─────────────────────────────────────────

if [ -n "${MODEL:-}" ]; then
  MODEL_ARG="$MODEL"
elif [ -f "${PERSONA_DIR:-/persona}/model.txt" ]; then
  MODEL_ARG=$(cat "${PERSONA_DIR:-/persona}/model.txt")
else
  MODEL_ARG="openrouter/anthropic/claude-sonnet-4"
fi

# Strip "openrouter/" prefix — pi uses the provider name directly
# e.g. "openrouter/anthropic/claude-sonnet-4" → pi --model openrouter/anthropic/claude-sonnet-4
# pi's --model supports the "provider/model" format natively

# ─── 4. Build pi command ────────────────────────────────────────

PI_ARGS=()

# Mode: JSON event stream
PI_ARGS+=("--mode" "json")

# Model
PI_ARGS+=("--model" "$MODEL_ARG")

# API key
PI_ARGS+=("--api-key" "${OPENROUTER_API_KEY}")

# System prompt: use --append-system-prompt for persona instructions
# This adds to the default coding assistant system prompt
PERSONA_DIR="${PERSONA_DIR:-/persona}"

if [ -f "$PERSONA_DIR/SYSTEM.md" ]; then
  PI_ARGS+=("--append-system-prompt" "$PERSONA_DIR/SYSTEM.md")
fi

# Instructions as the prompt (the first positional argument to pi)
# We'll pipe them in or use the prompt directly
INSTRUCTIONS=""
if [ -f "${INSTRUCTIONS_FILE:-/tmp/instructions.txt}" ]; then
  INSTRUCTIONS=$(cat "${INSTRUCTIONS_FILE:-/tmp/instructions.txt}")
fi

# Context: append to system prompt
if [ -s "${CONTEXT_FILE:-/tmp/context.txt}" ]; then
  PI_ARGS+=("--append-system-prompt" "${CONTEXT_FILE:-/tmp/context.txt}")
fi

# Skills (if persona has them)
if [ -d "$PERSONA_DIR/skills" ]; then
  for skill_dir in "$PERSONA_DIR/skills"/*/; do
    if [ -d "$skill_dir" ] && [ -f "$skill_dir/SKILL.md" ]; then
      PI_ARGS+=("--skill" "$skill_dir/SKILL.md")
    fi
  done
fi

# Summarize reminder — appended to system prompt
SUMMARIZE_REMINDER="IMPORTANT: When you have completed your task (or cannot make further progress), you MUST write a JSON result file to /output/result.json using the write tool. Use this exact format:

{
  \"status\": \"success\" | \"partial\" | \"failed\",
  \"summary\": \"Brief description of what was accomplished\",
  \"filesModified\": [\"path/to/file\"],
  \"filesCreated\": [\"path/to/file\"],
  \"commits\": [\"commit message\"],
  \"issues\": [\"any issues encountered\"],
  \"suggestions\": [\"suggestions for next steps\"]
}

Then commit and push any changes to the current branch with an appropriate commit message."

PI_ARGS+=("--append-system-prompt" "$SUMMARIZE_REMINDER")

# ─── 5. Run pi ──────────────────────────────────────────────────

echo "Starting pi with model $MODEL_ARG..." >&2
echo "Instructions: ${INSTRUCTIONS:0:100}..." >&2

# Run pi with the instructions as the prompt in non-interactive mode
# --print: process prompt and exit (allows multi-turn tool use within one invocation)
if [ -n "$INSTRUCTIONS" ]; then
  pi "${PI_ARGS[@]}" --print "$INSTRUCTIONS" 2>/dev/null | tee /output/events.jsonl
  EXIT_CODE=${PIPESTATUS[0]}
else
  echo '{"type":"error","message":"No instructions provided"}' >&2
  exit 1
fi

echo "Pi exited with code $EXIT_CODE" >&2

# ─── 6. Verify result.json exists ───────────────────────────────

if [ ! -f /output/result.json ]; then
  echo "Warning: /output/result.json not created by agent" >&2

  # Try to create a basic result from the events
  # Look for the last assistant message
  if [ -f /output/events.jsonl ]; then
    LAST_MSG=$(grep '"message_end"' /output/events.jsonl | tail -1 || true)
    if [ -n "$LAST_MSG" ]; then
      # Extract text content from the last message
      SUMMARY=$(echo "$LAST_MSG" | python3 -c "
import sys, json
try:
    msg = json.loads(sys.stdin.read())
    content = msg.get('message', {}).get('content', [])
    texts = [c['text'] for c in content if c.get('type') == 'text']
    print(' '.join(texts)[:500])
except:
    print('Agent completed but did not produce a result file')
" 2>/dev/null || echo "Agent completed")

      echo "{\"status\":\"partial\",\"summary\":\"$SUMMARY\"}" > /output/result.json
    fi
  fi
fi

# Push any changes (only if token is available)
cd /workspace/repo
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "feat: agent changes for task" 2>/dev/null || true
fi

if [ -n "${GIT_TOKEN:-}" ]; then
  git push origin HEAD 2>/dev/null || echo "Warning: push failed" >&2
else
  echo "No GIT_TOKEN set, skipping push" >&2
fi

exit $EXIT_CODE
