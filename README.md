# Shepherds Pi

Local CLI tool that automates software development by coordinating specialized AI agents through an LLM-powered Orchestrator. Users set goals via a TUI, the Orchestrator plans and dispatches agents, reviews results, iterates, and merges code back into the project repository.

**Everything is pi** — the Orchestrator is a pi SDK session, agents are pi CLI processes in Docker containers. No custom agent runtime.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Ink TUI                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │Chat Pane │  │Agent List│  │Plan View / Detail │  │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
│       └──────────────┼─────────────────┘            │
│                      │                              │
│              OrchestratorManager                     │
│              (bridge: TUI state ↔ sessions)         │
└──────────────────────┼──────────────────────────────┘
                       │
              ┌────────┴────────┐
              │  Orchestrator   │  pi SDK session with
              │  (coordinator)  │  10 custom tools, no coding tools
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
    ┌─────┴─────┐ ┌───┴────┐ ┌────┴─────┐
    │  Agent 1  │ │ Agent 2│ │ Agent N  │   Docker containers
    │ (persona) │ │(persona│ │ (persona)│   running pi --mode json
    │  o3       │ │sonnet-4│ │gemini-2.5│   clone repo → work → push
    └───────────┘ └────────┘ └──────────┘
```

### Key Design Decisions

- **Orchestrator coordinates, never codes** — only has orchestration tools (spawn_agent, create_branch, read_plan, etc.), no read/write/edit/bash
- **Agents are one-shot Docker containers** — spawned with a persona + instructions, write `/output/result.json` when done, container is removed
- **All communication routed through Orchestrator** — agents never talk to each other
- **Emergent flow** — Orchestrator reasons and decides next steps, not a rigid phase sequence
- **Run log as external memory** — survives context compaction, queryable via `read_run_log` tool
- **Per-persona model selection** — o3 for planning/integration, claude-sonnet-4 for coding, gemini-2.5-pro for review

## Project Structure

```
shepherds-pi/
├── docker/
│   ├── Dockerfile              # Agent container image (Node 20 + pi)
│   └── entrypoint.sh           # Clone repo, build prompt, run pi
├── personas/
│   ├── architect/              # o3 — designs solutions, creates plans
│   ├── dba/                    # claude-sonnet-4 — schemas, migrations
│   ├── typescript-api-dev/     # claude-sonnet-4 — backend API code
│   ├── typescript-react-dev/   # claude-sonnet-4 — frontend React code
│   ├── code-reviewer/          # gemini-2.5-pro — reviews code quality
│   ├── web-tester/             # claude-sonnet-4 — tests web apps
│   └── integrator/             # o3 — merges branches, resolves conflicts
│   └── <persona>/
│       ├── SYSTEM.md           # Persona system prompt
│       ├── model.txt           # Model ID (e.g., openrouter/openai/o3)
│       └── skills/summarize/
│           └── SKILL.md        # Instructs agent to write result.json
├── src/
│   ├── index.tsx               # Entry point — loads config, renders TUI
│   ├── App.tsx                 # Main TUI component (Ink/React)
│   ├── types.ts                # Shared TypeScript types
│   ├── utils.ts                # Helpers (getElapsed, path normalization)
│   ├── config/
│   │   └── index.ts            # Loads shepherds-pi.yaml + .env + auth fallbacks
│   ├── db/
│   │   └── index.ts            # SQLite (better-sqlite3) — runs, plans, agents, log, messages
│   ├── persona/
│   │   └── index.ts            # Loads persona dirs, builds agent prompts
│   ├── agent/
│   │   └── spawner.ts          # Docker container lifecycle via dockerode
│   ├── orchestrator/
│   │   ├── coordinator.md      # Orchestrator system prompt
│   │   ├── event-bus.ts        # Typed event bus (TUI ↔ session communication)
│   │   ├── tools.ts            # 10 orchestration tools (defineTool from pi SDK)
│   │   ├── session.ts          # Creates pi SDK session with custom tools
│   │   └── manager.ts          # Bridge: manages goals, routes events, updates TUI state
│   ├── components/             # Ink TUI components
│   │   ├── ChatPane.tsx        # Message display (no truncation, wraps naturally)
│   │   ├── AgentList.tsx       # Agent status sidebar
│   │   ├── AgentDetail.tsx     # Expanded agent view
│   │   ├── GoalTabs.tsx        # Goal switcher (1-9 keys)
│   │   ├── PlanView.tsx        # Implementation plan display
│   │   └── InputBar.tsx        # User input with ask_user support
│   └── test/                   # Test scripts
│       ├── foundation.ts       # DB, config, persona loading
│       ├── orchestrator.ts     # Event bus, tools, DB operations
│       ├── manager.ts          # Manager state, conversions
│       ├── sanitize.ts         # JSON control-char sanitizer
│       └── spawn-agent.ts      # End-to-end Docker agent test
├── shepherds-pi.yaml           # Project configuration
├── .env.example                # Template for secrets (gitignored)
└── SPEC.md                     # Full specification (~1400 lines)
```

## Orchestrator Tools

The coordinator has 10 tools (no coding tools):

| Tool | Purpose |
|------|---------|
| `spawn_agent` | Spawn one agent in Docker, block until completion |
| `spawn_agents` | Spawn multiple independent agents in parallel |
| `create_branch` | Create + push a git branch from base |
| `list_branches` | List all local/remote branches |
| `get_branch_diff` | Diff a feature branch against base |
| `read_plan` | Read current plan from DB |
| `update_plan` | Create/update the plan (versioned) |
| `read_run_log` | Read chronological journal (survives compaction) |
| `ask_user` | Pause and ask user a question (Promise-based) |
| `update_goal_status` | Signal goal progress |

## Setup

### Prerequisites

- Node.js 20+
- Docker Desktop (running)
- OpenRouter API key
- GitHub PAT with `repo` scope

### Install

```bash
git clone https://github.com/CounterpointConsulting/shepherds-pi.git
cd shepherds-pi
npm install
```

### Configure

1. Copy `.env.example` to `.env` and fill in secrets:
   ```
   GIT_TOKEN=ghp_yourGitHubPat
   OPENROUTER_API_KEY=sk-or-v1_yourKey
   ```

2. Edit `shepherds-pi.yaml` for your project (repo path, branches, models).

3. Login to pi for OpenRouter (stores key in pi auth, alternative to .env):
   ```bash
   pi --login openrouter
   ```

4. Build the Docker agent image:
   ```bash
   npm run docker:build
   ```

### Run

```bash
npm run dev
```

Type a goal in the TUI to start orchestration. The coordinator will plan, spawn agents, and coordinate the work.

## TUI Keybindings

| Key | Action |
|-----|--------|
| `1-9` | Switch between goals |
| `Tab` | Toggle focus (chat ↔ agents) |
| `↑↓` | Navigate agent list |
| `Enter` | Expand selected agent |
| `Escape` | Go back |
| `p` | Plan view |
| `Ctrl+C` | Quit |

When the coordinator calls `ask_user`, the input bar highlights yellow and your next message resolves the question.

## Configuration

### Token Resolution Order

Secrets are resolved in this priority:

1. `.env` file in project root
2. Shell environment variables
3. Pi auth storage (`~/.pi/agent/auth.json`) — OpenRouter key only
4. Git credential manager — GitHub token only

### shepherds-pi.yaml

```yaml
version: 1
project:
  name: my-project
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
  git_token_env: GIT_TOKEN
```

## Agent Lifecycle

1. Orchestrator calls `spawn_agent(persona, instructions, branch)`
2. Spawner creates Docker container with persona + instructions mounted
3. Entrypoint clones the repo on the target branch
4. Pi runs inside the container with `--mode json --print`
5. Agent uses coding tools (read, write, edit, bash) to complete the task
6. Agent writes `/output/result.json` with structured result
7. Entrypoint commits and pushes changes
8. Spawner reads `result.json` from the mounted output directory
9. Container is removed, result returns to the Orchestrator

## Result Schema Notes

Agent `result.json` payloads use **camelCase** keys as the canonical schema (for example: `filesCreated`, `filesModified`, `dependsOn`, `testsPassed`, `stepsToReproduce`).

For backward compatibility, the spawner normalizes older snake_case payloads on ingest, but new persona skills and docs should always emit camelCase.

## Testing

```bash
# Unit tests (no API keys needed)
npx tsx src/test/foundation.ts     # DB, config, personas
npx tsx src/test/orchestrator.ts   # Event bus, tools, DB
npx tsx src/test/manager.ts        # Manager state management
npx tsx src/test/sanitize.ts       # JSON control-char sanitizer

# E2E agent test (needs Docker + API keys)
npx tsx src/test/spawn-agent.ts code-reviewer "Review package.json"
npx tsx src/test/spawn-agent.ts architect "Analyze this codebase"
```

## Known Issues / TODO

- [ ] Compaction resilience — inject "call read_run_log" reminder when context is compacted
- [ ] Streaming polish — show live agent output in expanded detail view
- [ ] Error recovery — retry failed agents, escalate to user
- [ ] Agent result display — render full findings/suggestions in expanded view
- [ ] Multiple goals — test concurrent goals with separate sessions
- [ ] Branch strategy — agents currently branch off `main`, need `dev` branch workflow
- [ ] Prompt optimization — coordinator prompt may need tuning for emergent planning
