# Shepherds Pi

Local CLI tool that automates software development by coordinating specialized AI agents through a coordinator persona running directly in pi. Shepherds-Pi launches pi with a coordinator system prompt and a Shepherds extension that provides orchestration tools.

**Everything is pi** — coordinator and UI are native pi; Shepherds contributes extension tools for spawning and managing agent containers.

> Working on this repo with an AI agent? See [`AGENTS.md`](./AGENTS.md) for a
> concise architecture/implementation reference and the gotchas that matter
> (modes, the agent image, and how to keep test projects in sync).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  shepherds-pi CLI                    │
│  - resolves shepherds-pi.yaml                        │
│  - launches pi with coordinator system prompt        │
│  - loads Shepherds extension tools                   │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────┴────────┐
              │       pi        │  default pi UI + session runtime
              │   coordinator   │  no built-in coding tools enabled
              └────────┬────────┘
                       │ calls custom tools
          ┌────────────┼────────────┐
          │            │            │
    ┌─────┴─────┐ ┌───┴────┐ ┌────┴─────┐
    │  Agent 1  │ │ Agent 2│ │ Agent N  │   Docker containers
    │ (persona) │ │(persona│ │ (persona)│   mounted worktree/clone → work → host/container git finalize
    └───────────┘ └────────┘ └──────────┘
```

### Key Design Decisions

- **Coordinator coordinates, never codes** — Shepherds launches pi with `--no-builtin-tools`; only orchestration extension tools are active
- **Agents are one-shot Docker containers** — spawned with a persona + instructions, write `/output/result.json` when done, container is removed
- **Host-managed git supported via worktrees** — branch worktrees are prepared on host and mounted into containers
- **All communication routed through Orchestrator** — agents never talk to each other
- **Emergent flow** — Orchestrator reasons and decides next steps, not a rigid phase sequence
- **Run log as external memory** — survives context compaction, queryable via `read_run_log` tool
- **Per-persona model selection** — o3 for planning/integration, claude-sonnet-4 for coding, gemini-2.5-pro for review

### Coordinator Behavior Rules

The coordinator prompt (`src/orchestrator/coordinator.md`) enforces:

- **Concrete success criteria** — every task/step must have objectively
  verifiable success criteria defined when the agent is dispatched.
- **Mandatory test-agent verification** — before a task is considered complete,
  a test agent must verify the criteria and report back. For web apps the
  `web-tester` MUST use the **playwright skill**. Self-reported success from the
  implementing agent is not sufficient.
- **Send-back on failure** — if verification fails, the task goes back to an
  agent of the appropriate type for revision with the test findings.
- **Retry cap / stuck detection** — a given task is dispatched at most **10
  times** (initial + revisions); after that the coordinator stops and alerts the
  user that the agents are stuck.
- **Quality gates** — every implementation is reviewed AND tested before the
  integrator merges.

## Project Structure

```
shepherds-pi/
├── docker/
│   ├── Dockerfile              # Agent container image (Node 20 + pi + Playwright/Chromium)
│   └── entrypoint.sh           # Prepare repo (clone or mounted), load persona skills, run pi, optional in-container git finalize
├── personas/
│   ├── architect/              # o3 — designs solutions, creates plans
│   ├── dba/                    # claude-sonnet-4 — schemas, migrations
│   ├── typescript-api-dev/     # claude-sonnet-4 — backend API code
│   ├── typescript-react-dev/   # claude-sonnet-4 — frontend React code
│   ├── code-reviewer/          # gemini-2.5-pro — reviews code quality
│   ├── web-tester/             # claude-sonnet-4 — tests web apps via playwright (mandatory)
│   │   └── skills/playwright-skill/  # bundled browser automation (no node_modules)
│   ├── integrator/             # o3 — merges branches, resolves conflicts
│   ├── using-agent-skills/     # shared meta-skill for dynamic workflow skill selection
│   └── <persona>/
│       ├── SYSTEM.md           # Persona system prompt
│       ├── model.txt           # Model ID (e.g., openrouter/openai/o3)
│       └── skills/*/
│           └── SKILL.md        # Workflow skills + summarize handoff contract
├── src/
│   ├── cli.ts                  # Entry point — runs init/doctor/setup or launches pi coordinator mode
│   ├── utils.ts                # Helpers
│   ├── config/
│   │   └── index.ts            # Loads shepherds-pi.yaml + .env + auth fallbacks
│   ├── db/
│   │   └── index.ts            # SQLite (runs, plans, agents, log, messages)
│   ├── persona/
│   │   └── index.ts            # Loads persona dirs used by spawned agents
│   ├── agent/
│   │   └── spawner.ts          # Docker container lifecycle via dockerode
│   ├── git/
│   │   ├── worktree-manager.ts # Host worktree lifecycle + branch lease locks
│   │   └── host-git-manager.ts # Host-side add/commit/push finalization
│   ├── orchestrator/
│   │   ├── coordinator.md      # Coordinator system prompt passed to pi
│   │   └── tools.ts            # Orchestration tools (spawn_agent, update_plan, ask_user, etc.)
│   ├── extensions/
│   │   └── shepherds/index.ts  # Pi extension registering Shepherds tools + status widget
│   ├── scripts/
│   │   └── docker-build.ts     # `npm run docker:build` wrapper
│   ├── commands/               # init / doctor / setup subcommands
│   └── test/                   # Test scripts
│       ├── foundation.ts       # DB, config, persona loading
│       ├── orchestrator.ts     # Event bus, tools, DB operations
│       ├── sanitize.ts         # JSON control-char sanitizer
│       ├── worktree-manager.ts # Worktree + branch lock tests
│       ├── host-git-manager.ts # Host commit/push finalization tests
│       └── spawn-agent.ts      # End-to-end Docker agent test
├── scripts/
│   ├── copy-assets.mjs         # Copies coordinator.md into dist/ during build
│   └── sync-to-project.mjs     # Re-sync source → a test/consumer project (npm run sync)
├── templates/
│   └── shepherds-pi.yaml       # Template config scaffolded by `init`
├── shepherds-pi.yaml           # Project configuration
├── AGENTS.md                   # Architecture/impl reference for agents working on this repo
├── .env.example                # Template for secrets (gitignored)
└── SPEC.md                     # Full specification (~1400 lines)
```

## Orchestrator Tools

The coordinator has orchestration tools (no coding tools):

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
| `ask_user` | Prompt the user for clarification/input |
| `update_goal_status` | Signal goal progress |
| `shepherd_set_goal` | Record/update the active run goal in Shepherds state |

## Setup

### Prerequisites

- Node.js 20+
- Docker Desktop (running)
- OpenRouter API key
- GitHub PAT with `repo` scope (required for clone/container git modes)

### Install (global CLI)

```bash
npm i -g shepherds-pi
```

### Quick Start (inside your own project repo)

```bash
cd /path/to/your/project-repo
shepherds-pi init
cp .env.example .env
# Fill .env with your values
shepherds-pi doctor
shepherds-pi setup
shepherds-pi
```

### Install (project-local, team-friendly)

```bash
npm i -D shepherds-pi
npx shepherds-pi init
npx shepherds-pi doctor
npx shepherds-pi setup
npx shepherds-pi
```

### Commands

```bash
shepherds-pi init [--force] [--no-personas]
shepherds-pi doctor [--config <path>]
shepherds-pi setup [--config <path>]
shepherds-pi [--config <path>] [pi args...]
```

Configuration resolution order:
1. `--config <path>`
2. `SHEPHERDS_PI_CONFIG` env var
3. nearest `shepherds-pi.yaml` by walking upward from current directory

Start by describing your goal in the default pi prompt. The coordinator will plan, spawn agents, and coordinate the work using Shepherds tools.

> Note: when using host-managed git mode (`git.repo_mode=worktree` + `git.git_ops_mode=host`), no in-container clone/commit/push is performed.

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
  # Use the published image for normal use. When developing Shepherds Pi
  # locally, point this at your locally-built tag (e.g. shepherds-pi-agent:latest)
  # — `npm run sync` does this for you. See "Developing Shepherds Pi".
  image: ghcr.io/counterpointconsulting/shepherds-pi-agent:latest
  working_dir: /workspace/repo
openrouter:
  api_key: ${OPENROUTER_API_KEY}
coordinator:
  model: openrouter/anthropic/claude-sonnet-4
  thinking_level: high
personas_dir: ./.shepherds-pi/personas
agent:
  timeout_minutes: 30
  max_retries: 1
  git_token_env: GIT_TOKEN

git:
  repo_mode: worktree             # clone | worktree
  git_ops_mode: host              # container | host
  worktrees_dir: ./.shepherds-pi/worktrees
  author_name: Shepherds Pi Agent
  author_email: agent@shepherds-pi.dev
  reset_worktree_before_run: true
```

Notes:
- `repo_mode=worktree` mounts a host-prepared branch worktree into `/workspace/repo`.
- `git_ops_mode=host` disables in-container commit/push; the host commits/pushes after agent completion.
- `git_ops_mode=host` requires `repo_mode=worktree`.

## Agent Lifecycle

1. Orchestrator calls `spawn_agent(persona, instructions, branch)`
2. Spawner creates Docker container with persona + instructions mounted
3. Entrypoint either clones the repo (clone mode) or uses a host-mounted branch worktree (worktree mode)
4. Pi runs inside the container with `--mode json --print`
5. Agent uses coding tools (read, write, edit, bash) to complete the task
6. Agent writes `/output/result.json` with structured result
7. Git finalization happens either in-container (container mode) or on-host (host mode)
8. Spawner reads `result.json` from the mounted output directory
9. Container is removed, result returns to the Orchestrator

## Result Schema Notes

Agent `result.json` payloads use **camelCase** keys as the canonical schema (for example: `filesCreated`, `filesModified`, `dependsOn`, `testsPassed`, `stepsToReproduce`).

For backward compatibility, the spawner normalizes older snake_case payloads on ingest, but new persona skills and docs should always emit camelCase.

## Skill Authoring Pattern

Workflow skills should follow a consistent template. Use:

- `personas/SKILL_TEMPLATE.md` as the canonical structure for new skills
- `personas/using-agent-skills/SKILL.md` as the shared meta-skill for dynamic skill selection

`using-agent-skills` supports an optional requested skill list in instructions/context, for example:

```json
{
  "requestedSkills": ["security-and-hardening", "test-driven-development"]
}
```

Agents should load only the minimum relevant skills for the task, and always complete with `summarize`.

## Web Testing (Playwright)

The `web-tester` persona is required to verify web-application changes with a
real browser before they can be accepted.

- The **playwright skill** is bundled in the persona at
  `personas/web-tester/skills/playwright-skill/` (SKILL.md, run.js,
  lib/helpers.js, API_REFERENCE.md) — **without** `node_modules`.
- The agent **Docker image** installs Playwright + Chromium globally
  (`docker/Dockerfile`, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`), so the
  read-only-mounted skill can run browsers without a local install.
- `run.js` is adapted for the container: it resolves the global Playwright
  (`npm root -g`), writes temp scripts to `/tmp` (`PLAYWRIGHT_SKILL_TMP`), skips
  auto-install (`PLAYWRIGHT_SKILL_NO_INSTALL=1`), and defaults Chromium launches
  to `--no-sandbox` (the hardened container is the sandbox; opt out with
  `PLAYWRIGHT_SKILL_SANDBOX=1`).
- The coordinator dispatches `web-tester` with
  `requestedSkills: playwright-skill` plus the task's success criteria.

## Developing Shepherds Pi

When you change source in this repo and consume it from another project, three
artifacts can drift independently:

1. **CLI / coordinator code** — the global `shepherds-pi` runs `dist/`, so
   changes to TS or `coordinator.md` require `npm run build`.
2. **Agent Docker image** — entrypoint / Playwright / persona-skill changes
   require rebuilding the image, and the consuming project's `shepherds-pi.yaml`
   `image:` must point at that tag (not a stale published GHCR tag).
3. **Personas** — `shepherds-pi init` copies them into
   `<project>/.shepherds-pi/personas` once; they are not auto-updated afterward.

Use the sync script to update all three in one step:

```bash
npm run sync -- <path-to-project>              # build CLI + image, sync personas, pin image tag
npm run sync -- <path-to-project> --no-docker  # persona/coordinator-only changes (skip image rebuild)
npm run sync -- <path-to-project> --no-build   # skip the CLI build
npm run sync -- <path-to-project> --image <tag>
```

`scripts/sync-to-project.mjs` runs `npm run build`, builds
`shepherds-pi-agent:latest`, **replaces** the project's `.shepherds-pi/personas`
(source is the source of truth), and rewrites the `image:` line in the project's
`shepherds-pi.yaml` to the local tag.

> Drift trap: a container error of `GIT_URL not set` while your config uses
> `repo_mode: worktree` usually means the project is pointed at an **old**
> published image whose entrypoint only supports clone mode. Re-run `npm run sync`.

Common build commands:

```bash
npm run build         # clean + tsc + copy coordinator.md into dist/
npm run dev           # run the CLI from source via tsx
npm run docker:build  # build the shepherds-pi-agent:latest image
npm run typecheck
```

## Release / Publisher Setup

If you are maintaining and publishing Shepherds Pi (npm package + GHCR image), use:

- `docs/release-publisher-setup.md`

## Testing

```bash
# Unit tests (no API keys needed)
npx tsx src/test/foundation.ts       # DB, config, personas
npx tsx src/test/orchestrator.ts     # Event bus, tools, DB
npx tsx src/test/sanitize.ts         # JSON control-char sanitizer
npx tsx src/test/worktree-manager.ts # Worktree + lock behavior
npx tsx src/test/host-git-manager.ts # Host git finalization

# E2E worktree handoff cycle (Docker required, no API keys required)
npm run test:e2e:worktree

# E2E clone + in-container git handoff cycle (Docker required, no API keys required)
npm run test:e2e:clone

# Run both E2E architecture-mode tests
npm run test:e2e

# E2E agent test (needs Docker + API keys)
npx tsx src/test/spawn-agent.ts code-reviewer "Review package.json"
npx tsx src/test/spawn-agent.ts architect "Analyze this codebase"
# Optional branch override for worktree mode:
SHEPHERDS_TEST_BRANCH=shepherds-test/demo npx tsx src/test/spawn-agent.ts architect "Analyze this codebase"
```

## Known Issues / TODO

- [ ] Compaction resilience — inject "call read_run_log" reminder when context is compacted
- [ ] Error recovery — retry failed agents, escalate to user
- [ ] Richer coordinator dashboard widget in pi UI (status/history drill-down)
- [ ] Multiple goals — validate concurrent run handling and run selection ergonomics
- [ ] Branch strategy UX — improve branch naming conventions + policy guidance for coordinator-generated branches
- [ ] Prompt optimization — coordinator prompt may need tuning for emergent planning
