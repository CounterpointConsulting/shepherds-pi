# Shepherds Pi — Multi-Agent Software Development System

## 1. Overview

Shepherds Pi is a **local CLI tool** that automates software development by coordinating specialized AI agents, each running as a short-lived pi instance inside an isolated Docker container. A user provides a high-level goal, and an Orchestrator (itself a persistent pi session) decomposes it into a plan, spawns agents to execute each step, reviews their work, iterates until quality gates pass, and merges the results back into the project repository.

**Core principle: Everything is pi.** The Orchestrator is a pi session with custom tools. Agents are pi processes in Docker containers with persona configs. No custom agent runtime is built — pi handles all LLM interaction, tool calling, and context management.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        TUI Process (Ink)                         │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────────────────┐ │
│  │  Orchestrator Chat    │  │  Dashboard                       │ │
│  │  (user ↔ coordinator) │  │  (plan, agent status, branches)  │ │
│  └──────────┬───────────┘  └──────────────────────────────────┘ │
│             │                                                    │
│  ┌──────────▼──────────────────────────────────────────────────┐│
│  │           Orchestrator (pi SDK session)                      ││
│  │                                                              ││
│  │  Coordinator persona:                                        ││
│  │    - clarifies requirements with user                        ││
│  │    - creates and updates plans                               ││
│  │    - spawns agent containers                                 ││
│  │    - interprets agent results                                ││
│  │    - manages review/test/fix loops                           ││
│  │    - handles failures and escalation                         ││
│  │                                                              ││
│  │  Custom tools:                                               ││
│  │    spawn_agent, spawn_agents, create_branch,                 ││
│  │    read_plan, update_plan, read_run_log,                     ││
│  │    ask_user, list_branches, get_branch_diff,                 ││
│  │    update_goal_status                                        ││
│  │                                                              ││
│  │  Skills:                                                     ││
│  │    plan-creation, agent-selection, failure-recovery,         ││
│  │    review-interpretation                                     ││
│  └──────────┬──────────────┬──────────────┬────────────────────┘│
│             │              │              │                      │
└─────────────┼──────────────┼──────────────┼──────────────────────┘
              │              │              │
        ┌─────▼─────┐ ┌─────▼─────┐ ┌──────▼─────┐
        │  Agent 1   │ │  Agent 2   │ │  Agent N   │
        │  (Docker)  │ │  (Docker)  │ │  (Docker)  │
        │            │ │            │ │            │
        │ pi --mode  │ │ pi --mode  │ │ pi --mode  │
        │   json     │ │   json     │ │   json     │
        │ + persona  │ │ + persona  │ │ + persona  │
        │ + skills   │ │ + skills   │ │ + skills   │
        └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
              │              │              │
              └──────────────┴──────────────┘
                             │
                     ┌───────▼────────┐
                     │ Git Repository │
                     │  (local clone) │
                     │                │
                     │ dev ← feat/*  │
                     └────────────────┘
```

---

## 3. Technology Stack

| Component | Technology | Rationale |
|---|---|---|
| **Language** | TypeScript (Node.js) | Strong typing, async-native, matches pi's stack |
| **TUI** | Ink v4 (React for CLI) | Declarative UI, composable, custom layout |
| **Orchestrator** | pi SDK (`createAgentSession`) | Pi IS the orchestrator — we just add custom tools and a persona |
| **Agent Runtime** | pi CLI (`--mode json`) | Pi IS the agent — persona config + instructions in, structured result out |
| **LLM Access** | OpenRouter (via pi) | Fixed requirement; per-persona model selection |
| **Containers** | Docker via `dockerode` | Programmatic container lifecycle from Node |
| **Git** | `simple-git` (Orchestrator), pi's bash tool (agents) | Orchestrator manages branches; agents commit/push inside containers |
| **Agent Output** | Structured JSON via summarize skill + `/output/result.json` | Consistent interface across all persona types |
| **State** | SQLite via `better-sqlite3` | Plans, steps, agent runs, event log |
| **Config** | YAML (`shepherds-pi.yaml`) + persona directories | Project config + persona definitions |
| **Logging** | `pino` | Structured JSON logging |

---

## 4. Two Kinds of Pi

| | Orchestrator | Agent |
|---|---|---|
| **What it is** | A long-lived pi SDK session running in the TUI process | A short-lived pi CLI process in a Docker container |
| **Purpose** | Reason, plan, decide, coordinate | Execute a specific task |
| **LLM** | OpenRouter via pi (coordinator persona) | OpenRouter via pi (specialized persona) |
| **Tools** | Orchestration tools (spawn_agent, create_branch, etc.) | Coding tools (read, write, edit, bash) + persona-specific tools |
| **Skills** | plan-creation, agent-selection, failure-recovery, review-interpretation | Persona-specific skills (always includes summarize) |
| **State** | Persistent session (in-memory + SQLite) | Ephemeral — destroyed when container exits |
| **Output** | Decisions → TUI display + agent containers | Structured JSON at /output/result.json + code on git branch |
| **Lifecycle** | Runs for the duration of a goal | Runs for the duration of a step |
| **Communication** | Talks to TUI via event bus; talks to agents via tool calls | Streams JSON events to stdout; writes result file |

---

## 5. Orchestrator

### 5.1 Coordinator Persona

The Orchestrator's system prompt defines the coordinator behavior:

```
You are Shepherds Pi, an AI project coordinator. You manage a team of
specialized agents to achieve the user's goal. You NEVER write code
yourself — you coordinate, agents implement.

Your job is to reason about what needs to happen next and dispatch the
right agent to do it. There is no fixed workflow — you decide the
appropriate steps based on the goal, the current state of the project,
and the results of previous agents.

Principles:
- Understand the goal before acting — clarify with the user as needed
- Break work into discrete steps that a single specialist can complete
- Always review implementation before merging (dispatch a reviewer agent)
- Always test before merging (dispatch a tester agent)
- Review depth is configurable — specify thoroughness in reviewer instructions
- Re-spawn agents with feedback when review or testing requires changes
- If an agent fails, retry once with error context
- If still failing, re-evaluate the plan — decompose differently
- If still stuck after re-planning, ask the user for guidance
- Independent steps can run in parallel using spawn_agents
- Related steps that build on each other must be sequential

Context management:
- The run log is your external memory — call read_run_log to review
  what has happened, especially after context compaction
- When re-spawning an agent, include history: what was done, what the
  reviewer/tester found, and specific instructions for what to address
- When spawning a reviewer, include the original task description and
  the branch to review
- When spawning a tester, include the spec/requirements being tested
- When spawning an integrator, specify which branches to merge into dev
```

### 5.2 Orchestrator Tools

Custom pi extension that registers these tools on the Orchestrator session:

#### `spawn_agent`

Spawn a single agent container and wait for it to complete.

```typescript
{
  name: "spawn_agent",
  label: "Spawn Agent",
  description: "Spawn a single agent container with a specific persona and instructions. "
    + "Blocks until the agent completes and returns its structured result.",
  parameters: Type.Object({
    persona: Type.String({ description: "Persona name (e.g., 'dba', 'react-developer')" }),
    instructions: Type.String({ description: "Task instructions for the agent" }),
    branch: Type.Optional(Type.String({ description: "Git branch for the agent to work on" })),
    context: Type.Optional(Type.String({ description: "Additional context (JSON or text)" })),
    review_depth: Type.Optional(Type.String({
      description: "For reviewer personas: 'light', 'standard', or 'thorough'",
      enum: ["light", "standard", "thorough"]
    })),
  }),
  // Returns: AgentResult (parsed from /output/result.json)
}
```

The tool implementation:
1. Reads the persona config from `personas/{persona}/`
2. Creates feature branch if needed (using `simple-git` in the host)
3. Creates a Docker container with:
   - Persona config mounted at `/persona`
   - Instructions + context written to a mounted file
   - Repo volume-mounted or cloned via GIT_URL + GIT_TOKEN
   - Output directory mounted for `result.json`
4. Streams container stdout (pi JSON events) to the event bus (for TUI display)
5. Waits for container exit
6. Reads `/output/result.json` from the container
7. Returns the parsed result as the tool response to the LLM

If `result.json` is missing (agent didn't call summarize skill), the tool falls back to extracting the last assistant message from the JSON event stream.

If the container crashed entirely, returns:
```json
{
  "status": "failed",
  "summary": "Agent container exited with code 1",
  "issues": ["Container crashed — no structured output produced"]
}
```

**Auto-included context:** The tool automatically prepends to the agent's instructions:
- Current branch and its relationship to dev
- Previous agent results on this branch (from SQLite)
- Git log of recent commits on the branch

The LLM's `instructions` and `context` parameters are appended on top of this.

#### `spawn_agents`

Spawn multiple agent containers in parallel. Returns when all complete.

```typescript
{
  name: "spawn_agents",
  label: "Spawn Agents in Parallel",
  description: "Spawn multiple independent agents in parallel. Use when steps have "
    + "no dependencies on each other. Blocks until ALL agents complete. "
    + "Returns an array of results in the same order as the input agents.",
  parameters: Type.Object({
    agents: Type.Array(Type.Object({
      persona: Type.String(),
      instructions: Type.String(),
      branch: Type.Optional(Type.String()),
      context: Type.Optional(Type.String()),
    })),
  }),
  // Returns: AgentResult[]
}
```

The tool spawns all containers concurrently via `dockerode`, streams all their events to the event bus (tagged by agent ID), waits for all to complete, and returns an array of results.

#### `create_branch`

```typescript
{
  name: "create_branch",
  label: "Create Git Branch",
  description: "Create a new git branch from a base branch (usually dev)",
  parameters: Type.Object({
    name: Type.String({ description: "Branch name (e.g., 'feat/user-auth')" }),
    base: Type.Optional(Type.String({ description: "Base branch", default: "dev" })),
  }),
}
```

#### `read_run_log`

```typescript
{
  name: "read_run_log",
  label: "Read Run Log",
  description: "Read the journal of everything that has happened in this run. "
    + "Use this to understand the full trajectory of the run, especially after "
    + "context compaction. Optionally filter by event type or time range.",
  parameters: Type.Object({
    filter: Type.Optional(Type.String({
      description: "Filter: 'all', 'agents', 'branches', 'plan', 'latest'",
      enum: ["all", "agents", "branches", "plan", "latest"]
    })),
    since: Type.Optional(Type.String({
      description: "ISO timestamp — only events after this time"
    })),
  }),
  // Returns: formatted run journal text
}
```

The run log serves as the orchestrator's **external memory**. It persists across
pi context compaction and provides the ground truth for what has happened in a run.
Both the orchestrator (via `read_run_log`) and agents (via context composed by the
orchestrator) can reference it.

The run log is stored in two forms:
1. **SQLite** (`events` table) — structured, queryable, permanent
2. **Run journal file** (`<project>/.shepherds-pi/runs/<run-id>/journal.md`) —
   human-readable narrative auto-generated from structured events

Example journal:

```markdown
# Run Journal: Add user authentication

## 10:15 — Goal Set
User wants to add email/password authentication to the Next.js app.

## 10:17 — Plan Created (v1)
4 steps: schema → API → UI → integration

## 10:22 — Architect Completed (arch-001)
Analyzed codebase. Recommended schema: users (id, email, password_hash, created_at),
sessions (id, user_id, token, expires_at). Suggested bcrypt for hashing.

## 10:28 — DBA Completed (dba-001) on feat/user-auth
Created migrations 001_create_users.sql and 002_create_sessions.sql.

## 10:32 — Review: Changes Requested (dba-001-rev)
Missing index on users.email column. Will cause slow lookups.

## 10:37 — DBA Re-work Completed (dba-002) on feat/user-auth
Added migration 003_add_email_index.sql. Email column now indexed.

## 10:40 — Review: Approved (dba-002-rev)
All issues resolved. Migrations look good.
```

When pi compacts the orchestrator's conversation, the orchestrator extension
injects a reminder message: "Context was compacted. Call read_run_log to review
what has happened so far in this run."

#### `list_branches`

Note: `merge_branch` is intentionally NOT an orchestrator tool. Merging is
implementation work performed by the `integrator` agent persona. The orchestrator
dispatches an integrator agent when it decides branches should be merged.

```typescript
{
  name: "list_branches",
  label: "List Branches",
  description: "List all local git branches",
  parameters: Type.Object({}),
  // Returns: { name: string, current: boolean, lastCommit: string }[]
}
```

#### `get_branch_diff`

```typescript
{
  name: "get_branch_diff",
  label: "Get Branch Diff",
  description: "Get the diff of a feature branch against its base branch",
  parameters: Type.Object({
    branch: Type.String({ description: "Feature branch" }),
    base: Type.Optional(Type.String({ description: "Base branch", default: "dev" })),
  }),
  // Returns: { diff: string, filesChanged: string[], insertions: number, deletions: number }
}
```

#### `read_plan`

```typescript
{
  name: "read_plan",
  label: "Read Current Plan",
  description: "Read the current implementation plan from the database",
  parameters: Type.Object({}),
  // Returns: Plan object (steps, dependencies, status)
}
```

#### `update_plan`

```typescript
{
  name: "update_plan",
  label: "Update Plan",
  description: "Create or update the implementation plan",
  parameters: Type.Object({
    plan: Type.String({ description: "Plan as JSON string" }),
  }),
}
```

The plan structure:
```typescript
interface Plan {
  goal: string;
  steps: PlanStep[];
}

interface PlanStep {
  id: string;                    // "step-1"
  description: string;           // What to do
  persona: string;               // Which persona to use
  dependsOn: string[];           // Step IDs this depends on
  branch?: string;               // Feature branch (null for read-only personas)
  status: StepStatus;            // pending | in_progress | complete | failed | blocked
  agent_runs?: AgentRunSummary[]; // History of agent executions for this step
}
```

#### `ask_user`

```typescript
{
  name: "ask_user",
  label: "Ask User",
  description: "Ask the user a question and wait for their response. "
    + "Use when you need clarification, guidance, or approval.",
  parameters: Type.Object({
    question: Type.String({ description: "Question to ask the user" }),
  }),
  // Returns: user's response string
}
```

This tool pauses the Orchestrator's agent loop and emits an event to the TUI, which displays the question and waits for user input. The user's response is returned as the tool result.

#### `update_goal_status`

```typescript
{
  name: "update_goal_status",
  label: "Update Goal Status",
  description: "Update the current goal's status for the TUI dashboard",
  parameters: Type.Object({
    status: Type.String({ enum: ["planning", "executing", "reviewing", "testing", "merging", "completed", "failed", "blocked"] }),
    message: Type.Optional(Type.String()),
  }),
}
```

### 5.3 Orchestrator Skills

#### `plan-creation`

How to decompose a goal into a plan. What a good plan looks like. How to identify dependencies. When steps can run in parallel vs. must be sequential. How to assign the right persona to each step.

#### `agent-selection`

Reference for all available personas, when to use each one, what to expect from their output, and what model they use. Like a manager's guide to their team.

#### `failure-recovery`

What to do when an agent fails. When to retry, when to re-plan, when to ask the user. Escalation thresholds. How to compose re-spawn instructions that include failure context.

#### `review-interpretation`

How to read reviewer output. What "approved" vs. "changes_requested" means. How to translate review comments into instructions for the re-spawned implementor. How to specify review depth.

### 5.4 Orchestrator Event Bus

The Orchestrator emits events that the TUI subscribes to:

```typescript
type OrchestratorEvent =
  | { type: "goal_status_changed"; status: string; message?: string }
  | { type: "plan_updated"; plan: Plan }
  | { type: "agent_spawned"; agentId: string; persona: string; step: string; branch?: string }
  | { type: "agent_event"; agentId: string; event: AgentSessionEvent }  // proxied from container
  | { type: "agent_completed"; agentId: string; result: AgentResult }
  | { type: "user_question"; question: string }  // from ask_user tool
  | { type: "branch_created"; name: string; base: string }
  | { type: "run_log_entry"; entry: RunLogEntry }  // every event is also logged
;
```

---

## 6. Agents

### 6.1 Agent = Pi in Docker

Each agent is a Docker container that:
1. Starts up, clones/pulls the assigned branch using the provided GIT_TOKEN
2. Runs `pi --mode json` with the persona's system prompt, model, and skills
3. Pi does all the work (read, write, edit, bash — full tool suite)
4. The agent calls its `summarize` skill to write `/output/result.json`
5. Pi commits and pushes any code changes to the branch
6. Container exits

The Orchestrator reads the container's exit code and `result.json`.

### 6.2 Docker Image

```dockerfile
FROM node:20-bookworm

# System dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 python3-pip \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Install pi
RUN npm install -g @mariozechner/pi-coding-agent

# Directories
RUN mkdir -p /workspace /persona /output
WORKDIR /workspace

# Entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

Future: persona-specific images (e.g., `shepherds-pi-agent-pg` with PostgreSQL server).

### 6.3 Entrypoint Script

```bash
#!/bin/bash
set -e

# Environment variables (passed by Orchestrator via dockerode):
#   GIT_URL         - repository URL
#   GIT_TOKEN       - personal access token for git operations
#   BRANCH_NAME     - branch to checkout
#   PERSONA_DIR     - /persona (mounted volume with persona config)
#   INSTRUCTIONS    - task instructions (written to mounted file)
#   CONTEXT         - additional context (written to mounted file)
#   MODEL           - model override (optional)

# 1. Clone and checkout the branch
AUTH_URL=$(echo "$GIT_URL" | sed "s|://|://${GIT_TOKEN}@|")
git clone --branch "$BRANCH_NAME" --single-branch "$AUTH_URL" /workspace/repo
cd /workspace/repo

# 2. Configure git identity
git config user.name "Shepherds Pi Agent"
git config user.email "agent@shepherds-pi.dev"

# 3. Build the full system prompt
cat "$PERSONA_DIR/SYSTEM.md" > /tmp/system-prompt.md

# Append instructions
echo "" >> /tmp/system-prompt.md
echo "## Your Task" >> /tmp/system-prompt.md
cat /tmp/instructions.txt >> /tmp/system-prompt.md

# Append context if provided
if [ -s /tmp/context.txt ]; then
  echo "" >> /tmp/system-prompt.md
  echo "## Context" >> /tmp/system-prompt.md
  cat /tmp/context.txt >> /tmp/system-prompt.md
fi

# 4. Determine model
if [ -n "$MODEL" ]; then
  MODEL_ARG="$MODEL"
else
  MODEL_ARG=$(cat "$PERSONA_DIR/model.txt")
fi

# 5. Run pi
pi --mode json \
   --system-prompt "$(cat /tmp/system-prompt.md)" \
   --model "$MODEL_ARG" \
   --skill /persona/skills \
   --append-system-prompt "IMPORTANT: When you have completed your task, call the summarize skill to write your result to /output/result.json. Then commit and push any changes." \
   2>/dev/null | tee /output/events.jsonl

# Exit code is pi's exit code (0 = success)
```

### 6.4 Persona Structure

```
personas/
  architect/
    SYSTEM.md              # System prompt
    model.txt              # "openrouter/openai/o3"
    tools.json             # Tool whitelist (optional, defaults to all coding tools)
    skills/
      summarize/
        SKILL.md           # Required for all personas
        ...

  dba/
    SYSTEM.md
    model.txt              # "openrouter/anthropic/claude-sonnet-4"
    skills/
      summarize/
        SKILL.md

  typescript-api-dev/
    SYSTEM.md
    model.txt
    skills/
      summarize/
        SKILL.md

  typescript-react-dev/
    SYSTEM.md
    model.txt
    skills/
      summarize/
        SKILL.md

  python-dev/
    SYSTEM.md
    model.txt
    skills/
      summarize/
        SKILL.md

  code-reviewer/
    SYSTEM.md              # "You are a code reviewer. You do NOT write code..."
    model.txt              # "openrouter/google/gemini-2.5-pro"
    tools.json             # Read-only tools only
    skills/
      summarize/
        SKILL.md

  web-tester/
    SYSTEM.md
    model.txt
    skills/
      browser-use/         # Pi skill for browser automation
        SKILL.md
        ...
      summarize/
        SKILL.md

  api-tester/
    SYSTEM.md
    model.txt
    skills/
      summarize/
        SKILL.md

  debugger/
    SYSTEM.md
    model.txt
    skills/
      summarize/
        SKILL.md

  integrator/
    SYSTEM.md              # "You merge branches and resolve conflicts..."
    model.txt              # "openrouter/openai/o3"
    skills/
      summarize/
        SKILL.md
```

### 6.5 The Summarize Skill

Every persona has a `summarize` skill that produces structured output at `/output/result.json`. The schema varies by persona type:

#### Implementor summarize

```json
{
  "status": "success | partial | failed",
  "summary": "Brief description of what was done",
  "filesCreated": ["path/to/file1"],
  "filesModified": ["path/to/file2"],
  "commits": ["commit message 1"],
  "issues": ["Any issues or concerns"],
  "suggestions": ["Suggestions for the next agent"]
}
```

#### Reviewer summarize

```json
{
  "status": "approved | changes_requested | concerns",
  "summary": "Brief overall assessment",
  "approved": true,
  "findings": [
    {
      "severity": "critical | warning | info | suggestion",
      "file": "path/to/file",
      "description": "What was found",
      "suggestion": "How to fix it"
    }
  ]
}
```

`approved` is `false` if any findings are `critical` or `warning` severity. Review depth is controlled by the Orchestrator's instructions to the reviewer.

#### Tester summarize

```json
{
  "status": "passed | failed | blocked",
  "summary": "Brief overall test result",
  "testsRun": 5,
  "testsPassed": 4,
  "testsFailed": 1,
  "findings": [
    {
      "severity": "bug | regression | ux_issue | suggestion",
      "description": "What was found",
      "stepsToReproduce": ["step 1", "step 2"],
      "suggestion": "How to fix it"
    }
  ],
  "approved": true
}
```

#### Integrator summarize

```json
{
  "status": "success | conflicts | failed",
  "summary": "Brief description of merge result",
  "conflictsResolved": ["path/to/conflicting/file"],
  "conflictsRemaining": [],
  "testsPassed": true
}
```

---

## 7. Orchestration Flow

The orchestrator's workflow is **emergent**, not prescribed. It reasons about the
current state and decides what to do next. There is no fixed sequence of phases.

The orchestrator might:
- Start with an architect, or skip straight to implementation if the task is simple
- Review after every step, or batch-review multiple steps
- Run tests after each step, or wait until all implementation is done
- Merge incrementally or all at once
- Never need a debugger, or need one three times
- Discover mid-run that the plan needs to change and re-plan

What IS consistent are the **principles**:
- Understand the goal before acting
- Review implementation before merging
- Test before merging
- Re-spawn with feedback when quality gates fail
- Re-plan when stuck
- Ask the user when all else fails

### 7.1 Example Flow

```
User: "Add user authentication with email/password"
  │
  ▼
Orchestrator (coordinator persona) receives prompt
  │
  ▼
Orchestrator: "I need to clarify a few things..."
  → calls ask_user("Should I support social login too?")
  ← User: "Just email/password for now"
  │
  ▼
Orchestrator: "Let me have an architect analyze the codebase."
  → calls spawn_agent(persona="architect", instructions="Analyze the codebase and create an implementation plan for email/password authentication...")
    └─► [Docker: arch-001] → result: { plan with 4 steps, schema design, API contract }
  │
  ▼
Orchestrator: interprets plan, calls update_plan(...)
  │
  ▼
Orchestrator: creates feature branch
  → calls create_branch("feat/user-auth", "dev")
  │
  ▼
Orchestrator: starts with DBA
  → calls spawn_agent(persona="dba", branch="feat/user-auth", instructions="Create database migrations...", context=architect_output)
    └─► [Docker: dba-001] → result: { status: "success", filesModified: [...] }
  │
  ▼
Orchestrator: reviews the DBA's work
  → calls spawn_agent(persona="code-reviewer", branch="feat/user-auth", instructions="Review the database migrations...")
    └─► [Docker: dba-001-rev] → result: { approved: false, findings: [{ severity: "warning", ... }] }
  │
  ▼
Orchestrator: re-spawns DBA with review feedback
  → calls spawn_agent(persona="dba", branch="feat/user-auth", instructions="The reviewer found issues...", context=review_findings)
    └─► [Docker: dba-002] → result: { status: "success" }
  │
  ▼
Orchestrator: reviews again
  → calls spawn_agent(persona="code-reviewer", branch="feat/user-auth", ...)
    └─► [Docker: dba-002-rev] → result: { approved: true }
  │
  ▼
Orchestrator: moves to API implementation
  → calls spawn_agent(persona="typescript-api-dev", branch="feat/user-auth", instructions="Build REST API for auth...", context=architect_plan + dba_summary)
    └─► [Docker: api-001] → result: { status: "success" }
  │
  ▼
  ... (review → re-work if needed → next step) ...
  │
  ▼
Orchestrator: all implementation done, time to test
  → calls spawn_agent(persona="web-tester", branch="feat/user-auth", instructions="Test authentication flows...", context=full_spec)
    └─► [Docker: test-001] → result: { status: "passed" }
  │
  ▼
Orchestrator: tests pass, merge to dev
  → calls spawn_agent(persona="integrator", branch="feat/user-auth", instructions="Merge feat/user-auth into dev. Resolve any conflicts.")
    └─► [Docker: int-001] → result: { status: "success" }
  │
  ▼
Orchestrator: validate on dev
  → calls spawn_agent(persona="web-tester", branch="dev", instructions="Validate auth on dev after merge...")
    └─► [Docker: test-002] → result: { status: "passed" }
  │
  ▼
Orchestrator: done!
  → calls update_goal_status("completed")
```

### 7.2 Parallel Execution

When the orchestrator identifies independent steps:

```
Orchestrator LLM: calls spawn_agents({
  agents: [
    { persona: "dba", branch: "feat/user-auth-schema", instructions: "..." },
    { persona: "typescript-react-dev", branch: "feat/user-settings-ui", instructions: "..." }
  ]
})
  │
  ├─► [Docker: dba-001] → result: { status: "success", ... }
  └─► [Docker: react-001] → result: { status: "success", ... }
  │
  ▼
Both complete. Orchestrator reviews each, then proceeds.
```

### 7.3 Failure Recovery

When an agent fails, the orchestrator decides how to recover:

```
Agent fails (status: "failed" or container crash)
  │
  ▼
Orchestrator: retry once — spawn_agent with same task + error context
  │
  ├── Success → continue
  │
  └── Failure again
        │
        ▼
      Orchestrator: re-plan — decompose differently, change persona, add context
        │
        ├── Success → continue with new plan
        │
        └── Still failing
              │
              ▼
            Orchestrator: ask_user — "I'm stuck on step X. How should I proceed?"
```

The orchestrator might also:
- Spawn a debugger agent to analyze the issue before retrying
- Break a failing step into smaller steps
- Change the persona (e.g., switch from typescript-api-dev to a more capable model)
- Skip a step and return to it later
- Abandon an approach entirely and try a different one

### 7.4 Agent Respawn with History

When re-spawning an agent (e.g., implementor after review feedback), the Orchestrator includes:

- **What was done previously** — summary from the previous agent's result
- **What the reviewer/tester found** — relevant findings
- **Specific instructions** — what to address, what not to redo

Example `instructions` for a re-spawned implementor:
```
A previous implementor created the initial database migrations for user
authentication on this branch. A code reviewer found the following issues:

1. [WARNING] No index on the users.email column — this will cause slow lookups
2. [SUGGESTION] Consider adding a created_at default of NOW()

Please address issues #1 (required) and #2 (optional). Do not redo the
existing migrations — create a new migration file for the changes.

Previous work summary: Created migration 001_create_users.sql with columns
id, email, password_hash, and migration 002_create_sessions.sql with columns
id, user_id, token, expires_at.
```

---

## 8. Git Branching Model

```
main
 └── dev  ← all feature branches spawn from here, integrator merges back here
      ├── feat/user-auth
      ├── feat/user-settings-ui
      └── feat/bug-fix-login
```

- **`dev`** is the integration branch — source of truth for current state
- Each implementation agent works on a **feature branch** from `dev`
- Related sequential work shares the same feature branch (e.g., DBA → API dev → React dev all on `feat/user-auth`)
- Independent work gets separate branches and can run in parallel
- The **Integrator** agent persona merges feature branches back into `dev`
- After merge, feature branch is deleted
- QA/tester/reviewer personas that only **read** code still checkout a branch but don't need their own

---

## 9. Data Model (SQLite)

```sql
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  goal          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'planning',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE plans (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  steps         TEXT NOT NULL,               -- JSON: PlanStep[]
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_runs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  step_id       TEXT,                        -- Which plan step (nullable for architect, etc.)
  persona       TEXT NOT NULL,
  model         TEXT NOT NULL,
  instructions  TEXT NOT NULL,
  context       TEXT,                        -- JSON
  branch        TEXT,
  container_id  TEXT,
  status        TEXT NOT NULL DEFAULT 'spawning',
  result        TEXT,                        -- JSON: AgentResult from /output/result.json
  started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at  DATETIME
);

-- Run log: append-only journal of everything that happened in a run
-- This is the orchestrator's external memory and the ground truth
-- for composing agent context
CREATE TABLE run_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  timestamp     TEXT NOT NULL,               -- ISO 8601
  event_type    TEXT NOT NULL,               -- goal_set, plan_created, branch_created,
                                            -- agent_spawned, agent_completed, plan_updated,
                                            -- user_message, user_response, status_changed
  payload       TEXT NOT NULL,               -- JSON: event-specific data
  summary       TEXT                         -- Human-readable one-line summary
);

CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  role          TEXT NOT NULL,               -- user, coordinator
  content       TEXT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 10. Configuration File

`shepherds-pi.yaml` — lives in the project root:

```yaml
version: 1

project:
  name: my-app
  repo_path: .
  dev_branch: dev
  main_branch: main

docker:
  image: shepherds-pi-agent:latest
  working_dir: /workspace/repo

openrouter:
  api_key: ${OPENROUTER_API_KEY}

coordinator:
  model: openrouter/anthropic/claude-sonnet-4
  thinking_level: high

personas_dir: ./personas

agent:
  timeout_minutes: 30
  max_retries: 1
  git_token_env: GIT_TOKEN                    # env var name for the PAT
```

---

## 11. Phased Implementation Plan

### Phase 1: Foundation
- Project scaffolding (TypeScript, build, test setup)
- SQLite data model + migrations (runs, plans, agent_runs, run_log, messages)
- Config file parsing + validation (`shepherds-pi.yaml`)
- Persona directory structure + loader
- Docker image build (Dockerfile + entrypoint.sh)
- Run log writer (append-only journal + markdown renderer)

### Phase 2: Orchestrator Core
- pi SDK session setup with coordinator persona
- Custom pi extension with all orchestrator tools
- `spawn_agent` tool: Docker container creation, monitoring, result parsing
- `spawn_agents` tool: parallel container execution
- Git tools: create_branch, list_branches, get_branch_diff
- Plan tools: read_plan, update_plan
- Run log tool: read_run_log (with filters)
- ask_user tool: event emission + response wait
- Orchestrator event bus
- Context compaction handler (inject "call read_run_log" reminder)
- SQLite logging of agent runs and run log entries

### Phase 3: Agent Runtime
- Docker image with pi + git + common runtimes
- Entrypoint script (clone → configure → run pi → summarize → exit)
- Persona configs (SYSTEM.md, model.txt, skills)
- Summarize skill for each persona type
- Test: manually spawn an agent container and verify structured output

### Phase 4: Skills & Personas
- Coordinator skills: plan-creation, agent-selection, failure-recovery, review-interpretation
- Core personas: architect, dba, typescript-api-dev, typescript-react-dev, python-dev, code-reviewer, web-tester, api-tester, debugger, integrator
- Persona-specific skills (e.g., browser-use for web-tester)

### Phase 5: TUI
- Ink-based TUI scaffold
- Orchestrator chat pane (sends user input to Orchestrator session, displays responses)
- Dashboard pane (plan status, agent status, branch info, run log timeline)
- Agent detail view (streaming events from a specific agent container)
- Human intervention UI (ask_user prompts, BLOCKED state handling)

### Phase 6: Integration & Polish
- End-to-end test on a real project
- Review/test/fix loop validation
- Parallel agent execution validation
- Failure recovery and re-planning validation
- Graceful shutdown (stop containers, clean up branches)
- Run log replay / debugging
- Performance tuning (container startup time, context window management)

---

## 12. TUI Design

The TUI is a custom Ink (React for CLI) application. It does NOT use pi's built-in
interactive mode. Instead, it creates a pi SDK session for the orchestrator and
renders everything itself.

### 12.1 Architecture

```
Ink TUI Process
├── Orchestrator Session (pi SDK)
│   ├── Receives user input from chat pane
│   ├── Streams responses to chat pane
│   ├── Calls tools (spawn_agent, read_plan, etc.)
│   └── Emits events to event bus
│
├── Event Bus
│   ├── Orchestrator events → TUI re-renders
│   ├── Agent events (proxied from containers) → agent detail pane
│   └── ask_user events → input prompt in chat
│
├── SQLite
│   └── Read by TUI for dashboard data (plan, agents, run log)
│
└── Ink Components
    ├── ChatPane
    ├── AgentListPane
    ├── AgentDetailPane
    └── InputBar
```

### 12.2 Layout

The primary layout is a two-pane view:

```
┌────────────────────────────────────┬──────────────────────────┐
│  Shepherds Pi                      │  Agents                  │
│  Goal: Add user authentication     │                          │
├────────────────────────────────────┤  ┌────────────────────┐  │
│                                    │  │ ● dba-001   [done] │  │
│  🐑 Coordinator: I'll break this   │  │ ● dba-001-rev[done] │  │
│  down into steps. First, let me    │  │ ◐ dba-002   [run ] │  │
│  have an architect analyze the     │  │ ○ api-001   [pend] │  │
│  codebase...                       │  │ ○ test-001  [pend] │  │
│                                    │  └────────────────────┘  │
│  You: Make sure to use bcrypt      │                          │
│                                    │  ── dba-002 ──────────  │
│  🐑 Coordinator: Good call. I've   │  Persona: dba            │
│  updated the plan. Spawning the    │  Branch: feat/user-auth  │
│  DBA agent now...                  │  Status: 🔄 Running      │
│                                    │  Elapsed: 3m 12s        │
│  🔧 Spawning dba-002...            │                          │
│  📋 Review feedback: Missing       │  Instructions:           │
│  index on email column             │  Add index on email...   │
│                                    │                          │
│                                    │  ▸ View live stream      │
│                                    │  ▸ View result           │
│                                    │                          │
├────────────────────────────────────┴──────────────────────────┤
│ ▍ Type a message...                                [Enter] ↵ │
└───────────────────────────────────────────────────────────────┘
```

**Left pane (60-70% width):** Chat with the orchestrator. This is the primary
interaction surface. The user types here, the coordinator responds here.

**Right pane (30-40% width):** Agent list + selected agent detail. The top of
the pane shows a scrollable list of all agent runs. The bottom of the pane
shows details for the currently selected agent.

**Bottom bar:** Input field spanning full width. Always visible.

### 12.3 Pane Breakdown

#### Chat Pane (Left)

The chat is a scrollable message history between the user and the coordinator.
Each message shows:
- **User messages**: Right-aligned, user avatar/color
- **Coordinator messages**: Left-aligned, 🐑 icon, markdown rendered
- **Tool call notifications**: Inline, muted, showing what the coordinator did
  - `🔧 Spawning dba-002 (dba, feat/user-auth)...`
  - `📋 Plan updated (5 steps)`
  - `🌿 Branch created: feat/user-auth`
  - `✅ dba-002 completed: Created migrations...`
  - `❌ dba-002 failed: Container exited with code 1`
- **ask_user prompts**: Highlighted, with a visual indicator that the
  coordinator is waiting for input

Tool call notifications are derived from the Orchestrator's pi session events.
The TUI listens for `tool_execution_start` and `tool_execution_end` events and
renders them as inline notifications in the chat.

When the coordinator calls `ask_user`, the input bar is highlighted/pulsed
to indicate the coordinator is waiting for a response.

#### Agent List (Right, Top)

A scrollable, selectable list of all agent runs for the current goal:

```
 ● dba-001      dba              feat/user-auth    ✓ done
 ● dba-001-rev  code-reviewer    feat/user-auth    ✓ done
 ◐ dba-002      dba              feat/user-auth    ⟳ running
 ○ api-001      typescript-api   feat/user-auth    ◌ pending
 ○ test-001     web-tester       feat/user-auth    ◌ pending
```

Each row shows:
- **Status icon**: ✓ done, ⟳ running, ◌ pending, ✗ failed, ⚠ blocked
- **Agent ID**: Short identifier
- **Persona**: Which persona was used
- **Branch**: Feature branch (or "—" if none)
- **Status**: Text status

The list is ordered by start time (newest at bottom). The user navigates with
↑/↓ arrows (when the agent pane has focus). The selected agent's details appear
in the detail section below.

#### Agent Detail (Right, Bottom)

Shows expanded information for the selected agent:

```
 ── dba-002 ──────────────────────
 Persona: dba
 Model:   anthropic/claude-sonnet-4
 Branch:  feat/user-auth
 Status:  🔄 Running (3m 12s)

 Instructions:
 The reviewer found the following issues with your
 migrations: 1. [WARNING] No index on the email
 column... Please address issue #1.

 ▸ View live stream
 ▸ View result (when complete)
```

Actions available from the detail view:
- **View live stream**: Switches the agent detail to show the agent's real-time
  pi JSON event stream (text deltas, tool calls, tool results)
- **View result**: Shows the agent's structured result from `/output/result.json`
- **View instructions**: Full instructions text (scrollable)
- **View context**: Context that was passed to the agent

### 12.4 Agent Live Stream View

When the user selects "View live stream" on a running agent, the agent detail
pane expands to show the agent's pi event stream in real-time:

```
 ── dba-002 live ─────────────────

 [3:12] Reading db/migrations/001_create_users.sql
 [3:14] Running: npm run db:migrate
 [3:18] Editing db/migrations/003_add_email_index.sql
 [3:20] Running: git add -A && git commit
 [3:22] Writing /output/result.json
 [3:23] ✓ Task complete
```

The stream shows:
- **Tool calls**: What the agent is doing (read, write, edit, bash)
- **Progress messages**: Text output from the agent
- **Completion**: When the agent finishes

This is NOT a full verbatim transcript — it's a filtered, human-readable
summary of the pi JSON event stream. The TUI subscribes to `agent_event`
from the event bus and renders key events:
- `tool_execution_start` → "Reading path/to/file" / "Running: command"
- `message_update` (text deltas) → Progress text
- `tool_execution_end` → Result summary
- `agent_end` → Completion status

The stream scrolls automatically but the user can scroll up to see history.
Pressing Escape returns to the normal agent detail view.

### 12.5 View Modes

The TUI has three view modes, toggled by keyboard:

#### Default: Chat + Agent List/Detail

The two-pane layout described above. This is the primary working view.

#### Expanded: Agent Full View

When the user selects an agent and wants to see more, they can press Enter
on a selected agent (or select "View live stream" / "View result") to expand
the agent detail to take the full screen width:

```
┌──────────────────────────────────────────────────────────────┐
│  ← Back    dba-002 (dba) · feat/user-auth · ✓ done          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Instructions:                                               │
│  The reviewer found the following issues with your            │
│  migrations: 1. [WARNING] No index on the email column...    │
│                                                              │
│  ── Live Stream ──────────────────────────────────────────── │
│                                                              │
│  [3:12] Reading db/migrations/001_create_users.sql           │
│  [3:14] Running: npm run db:migrate                          │
│  [3:18] Editing db/migrations/003_add_email_index.sql        │
│  [3:20] Running: git add -A && git commit                   │
│  [3:22] Writing /output/result.json                          │
│  [3:23] ✓ Task complete                                      │
│                                                              │
│  ── Result ───────────────────────────────────────────────── │
│                                                              │
│  {                                                           │
│    "status": "success",                                      │
│    "summary": "Added email index migration",                 │
│    "filesModified": ["db/migrations/003_add_email_index.sql"],│
│    "commits": ["Add index on users.email column"],           │
│    "issues": [],                                             │
│    "suggestions": []                                         │
│  }                                                           │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ ▍ Type a message...                                [Enter] ↵ │
└──────────────────────────────────────────────────────────────┘
```

Pressing Escape returns to the default two-pane view.

#### Plan View

Toggled by pressing `p`. Shows the current plan as a formatted list:

```
┌──────────────────────────────────────────────────────────────┐
│  ← Back (p)              Plan: Add user authentication       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ✓ Step 1: Design schema and write migrations    [dba]       │
│    Branch: feat/user-auth                                    │
│    Agents: dba-001 (✓), dba-001-rev (✓), dba-002 (✓),       │
│            dba-002-rev (✓)                                   │
│                                                              │
│  ⟳ Step 2: Build REST API for authentication     [api-dev]   │
│    Branch: feat/user-auth                                    │
│    Depends on: Step 1 ✓                                      │
│    Agents: api-001 (⟳ running)                               │
│                                                              │
│  ◌ Step 3: Build React components for auth       [react-dev] │
│    Branch: feat/user-auth                                    │
│    Depends on: Step 1 ✓, Step 2 ⟳                            │
│                                                              │
│  ◌ Step 4: Integration test and merge            [integrator]│
│    Depends on: Step 2, Step 3                                │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ ▍ Type a message...                                [Enter] ↵ │
└──────────────────────────────────────────────────────────────┘
```

### 12.6 Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Tab` | Any | Toggle focus between chat pane and agent list pane |
| `↑`/`↓` | Agent list | Navigate agent list |
| `Enter` | Agent list | Expand selected agent to full view |
| `Escape` | Expanded view | Return to default two-pane view |
| `Escape` | Default view | (future: cancel/abort current operation) |
| `p` | Default view | Toggle plan view |
| `Enter` | Input bar | Send message to orchestrator |
| `Ctrl+C` | Any | Graceful shutdown (stop containers, clean up) |
| `Ctrl+D` | Any | Graceful shutdown |

### 12.7 Focus Model

The TUI uses a two-zone focus model:

1. **Chat zone** (default): Keyboard input goes to the input bar. User types
   messages and sends them to the orchestrator.

2. **Agent zone**: Tab switches focus to the agent list. ↑/↓ navigates,
   Enter expands. Tab switches back to chat zone.

The input bar is always visible and always accepts input, regardless of focus.
Only the ↑/↓/Enter keys are captured by the agent zone when it has focus.

### 12.8 Chat Message Rendering

The chat pane renders messages from the orchestrator's pi session. Messages are
extracted from the pi SDK session events:

- **User messages**: Rendered directly from the input bar
- **Coordinator text responses**: Rendered from `message_update` events
  (text_delta), assembled into full messages on `message_end`
- **Tool call notifications**: Rendered from `tool_execution_start`/`tool_execution_end`
  events, displayed as inline status lines
- **ask_user prompts**: Detected when the `ask_user` tool is called,
  highlighted in the chat with a visual indicator

Messages are rendered as markdown. Long messages are scrollable within the
chat pane.

### 12.9 Startup Flow

1. TUI launches, displays welcome screen
2. User types a goal in the input bar and presses Enter
3. TUI creates a pi SDK session with the coordinator persona
4. The goal is sent as the first prompt to the orchestrator
5. The orchestrator begins reasoning — chat pane shows its response
6. As the orchestrator dispatches agents, the agent list populates
7. User can interact (respond to questions, monitor agents, view details)

### 12.10 State Refresh

The TUI polls SQLite (or subscribes to the event bus) for:
- New agent runs (spawned by the orchestrator)
- Agent status changes (running → completed/failed)
- Plan updates
- Goal status changes

Agent live streams are pushed to the TUI via the event bus (not polled).

### 12.11 ask_user Interaction

When the orchestrator calls the `ask_user` tool:

1. The tool emits a `user_question` event to the event bus
2. The TUI highlights the input bar (pulsing border or color change)
3. A message appears in the chat: "🐑 Coordinator is asking: {question}"
4. The user types a response and presses Enter
5. The TUI resolves the `ask_user` promise with the user's response
6. The orchestrator receives the response as the tool result
7. The orchestrator continues reasoning

This is different from normal chat — when `ask_user` is active, the user's
next input goes to the tool response, not to a new conversation turn.

### 12.12 Terminal Size Handling

- **Minimum**: 80 columns × 24 rows
- **Recommended**: 120+ columns × 40+ rows
- On narrow terminals (< 100 columns), the agent pane collapses to a minimal
  status bar at the top of the chat pane
- On very narrow terminals (< 80 columns), show a warning and suggest resizing

### 12.13 Color Scheme

| Element | Color |
|---------|-------|
| Coordinator messages | Blue/cyan |
| User messages | White/default |
| Tool call notifications | Gray/muted |
| Agent running | Yellow/amber |
| Agent complete | Green |
| Agent failed | Red |
| Agent pending | Gray |
| Plan step complete | Green |
| Plan step in progress | Yellow |
| Plan step pending | Gray |
| Input bar border | Default, pulsing when ask_user is active |
| Status bar | Dim/gray |

---

## 13. Open Items (Future Discussion)

1. ~~TUI design~~ — See Section 12
2. **Context window management** — For large projects, how to avoid overwhelming agents with too much context. Project indexing? Smart file selection?
3. **Agent container caching** — Can we reuse containers across steps to avoid cold start? Or pre-warm containers?
4. **Cost tracking** — Aggregate OpenRouter costs per run, per step, per persona
5. **Multiple concurrent runs** — Should the system support multiple goals at once?
6. **Plan revision mid-execution** — When the coordinator re-plans, how to handle already-queued or in-progress steps
7. **Custom persona creation** — UI or CLI for users to define new personas for their project
8. **Agent skill marketplace** — Share persona configs and skills between projects
9. **Run log compaction** — When a run is long, should the journal be summarized? How to keep it useful without it becoming too large?
10. **Agent output streaming** — Resolved: streaming view in agent detail pane, see Section 13
