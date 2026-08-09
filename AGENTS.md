# AGENTS.md — Shepherds Pi

Working notes for AI agents (and humans) operating in this repository. Read this
first; it captures architecture, the moving parts, and the gotchas that are easy
to get wrong.

## What this project is

**Shepherds Pi** is a multi-agent product-development automation tool. A
**coordinator** (an instance of the `pi` coding agent running with a custom
system prompt + extension) takes a product idea from conversation to a usable,
tested release: it discovers/refines the idea with the user, agrees a plan, then
dispatches **specialist agents** (in parallel when possible) until the release
and remaining improvements are done. Each specialist runs in an isolated
**Docker container** for coding, review, testing, and merging. The coordinator
never writes code itself.

- Package name: `shepherds-pi` (CLI binary `shepherds-pi`), ESM, Node >= 20.
- Built on `@earendil-works/pi-coding-agent` (the `pi` agent harness).
- Repo remote: `github.com/CounterpointConsulting/shepherds-pi`.

## High-level architecture

```
shepherds-pi (CLI)
  └─ launches `pi` with:
       --system-prompt  src/orchestrator/coordinator.md   (the coordinator's brain)
       --extension      src/extensions/shepherds/index.ts  (registers tools + UI)
       --model/--thinking from shepherds-pi.yaml
            │
            ├─ Coordinator LLM uses orchestrator TOOLS (src/orchestrator/tools.ts):
            │     spawn_agent / spawn_agents, create_branch, list_branches,
            │     get_branch_diff, merge_branch, read_plan/update_plan,
            │     read_run_log, ask_user, update_goal_status, shepherd_set_goal
            │
            └─ spawn_agent → spawnAgent() (src/agent/spawner.ts)
                   └─ docker run  shepherds-pi-agent  image
                         entrypoint.sh runs `pi` inside the container with the
                         persona's SYSTEM.md + skills, the task instructions,
                         and writes /output/result.json back to the host.
```

State (runs, plans, agent runs, run log, messages) is persisted in a SQLite DB
at `<project>/.shepherds-pi/shepherds.db` (`src/db/index.ts`,
`better-sqlite3`). The run log is the coordinator's "external memory."

## Source layout (`src/`)

| Path | Responsibility |
|---|---|
| `cli.ts` | Entry point. Subcommands `init` / `doctor` / `setup`; default mode launches the coordinator `pi`. Resolves coordinator prompt + extension from `dist/` (built) or `src/` (dev). |
| `config/index.ts` | `loadConfig()`, `ShepherdsPiConfig` interfaces, `.env` loader, `${VAR}` interpolation, `getGitToken()`. |
| `config/resolve-config.ts` | `resolveConfigPath()` — order: `--config` → `SHEPHERDS_PI_CONFIG` → walk up from CWD for `shepherds-pi.yaml`. Throws if none found. |
| `orchestrator/coordinator.md` | The coordinator **system prompt** (sole mission: discover → agree spec → plan → drive team to usable release; principles; quality gates; retry/stuck; persona list). Editing this changes coordinator behavior. |
| `orchestrator/tools.ts` | All coordinator tools (the factory `createOrchestratorTools`). Owns the worktree manager, git URL/token resolution, spawn lifecycle, and optional Beads work-graph tools. |
| `beads/` | Host-side `bd` client + tool wrappers. When `beads.enabled`, Beads is the plan of record (replaces free-form `read_plan`/`update_plan`). |
| `agent/spawner.ts` | `spawnAgent()` runs an agent container (security-hardened); `buildDockerImage()` / `ensureImage()`. Streams stdout via container attach (fallback to `docker logs`). Parses `/output/result.json`. |
| `agent/container-name.ts` | Funny unique container names. |
| `extensions/shepherds/index.ts` | The `pi` extension: registers tools on `session_start`, status widget, `ask_user` UI wiring (uses `ctx.ui.input`), `/shepherd-status` command, `shepherd_set_goal` tool. |
| `persona/index.ts` | `loadPersona` / `loadPersonas` — reads `SYSTEM.md`, `model.txt`, `skills/`, `tools.json` from a persona dir. |
| `git/worktree-manager.ts` | Worktree mode: per-branch git worktrees under `worktrees_dir`, file-lock leases, reset-before-run. |
| `git/host-git-manager.ts` | Host-managed git: `finalizeAgentChanges()` commits/pushes an agent's own file changes to its own branch after it finishes (used when `git_ops_mode: host`). Does NOT do cross-branch merges. |
| `git/host-merge-manager.ts` | Host-side branch integration for the `merge_branch` tool: `--no-ff` merge in an ephemeral detached worktree under `worktrees_dir/.integration/`; clean merges auto commit+push; conflicts leave the worktree for a resolver agent, then `finalizeMerge()` commits+pushes. Always cleans up the integration worktree. |
| `db/index.ts` | SQLite schema + migrations + accessors (runs, plans, agent_runs, run_log, messages, agent_transcripts). Migration 2 adds per-agent usage columns + the transcript archive. |
| `agent/usage.ts` | Parses per-agent LLM token/cost usage from the pi JSON event stream (sums `usage` from `message_end` assistant turns only; start/update events would double-count). |
| `commands/history.ts` | `shepherds-pi history` — dev-history + LLM usage/cost review (per-agent table, by-model/by-persona rollups, `--run`/`--cost`/`--json`/`--transcripts`). |
| `commands/{init,doctor,setup}.ts` | `init` scaffolds config/env/personas into a target project; `doctor` validates prereqs; `setup` pulls/builds the agent image. |
| `commands/history.ts` | `history` subcommand (see above). |
| `scripts/docker-build.ts` | `npm run docker:build` wrapper around `buildDockerImage()`. |
| `test/*.ts` | Foundation, orchestrator, sanitize, worktree-manager, host-git-manager, and e2e handoff tests (run via `tsx`). |

## Personas (`personas/`)

Each subdir = one specialist agent. Contents: `SYSTEM.md` (required),
`model.txt`, optional `skills/<name>/SKILL.md`, optional `tools.json`.

| Persona | Model | Role |
|---|---|---|
| `architect` | openrouter/x-ai/grok-4.5 | Analyze codebase, create implementation plans |
| `dba` | openrouter/x-ai/grok-4.5 | DB schema design, migrations |
| `typescript-api-dev` | openrouter/x-ai/grok-4.5 | REST API development |
| `typescript-react-dev` | openrouter/x-ai/grok-4.5 | React components |
| `code-reviewer` | openrouter/x-ai/grok-4.5 | Code review / quality gate |
| `web-tester` | openrouter/x-ai/grok-4.5 | Browser testing via **playwright-skill** (mandatory) |
| `integrator` | openrouter/x-ai/grok-4.5 | Branch merging / conflict resolution |
| `using-agent-skills` | (meta) | Shared meta-skill mounted into every agent for dynamic skill selection |

`SKILL_TEMPLATE.md` is a template for authoring new skills.

### web-tester + playwright (important)
- `web-tester` MUST use `playwright-skill` to verify web changes. This is
  enforced in `personas/web-tester/SYSTEM.md`, the `test-plan-and-execution`
  skill, and the coordinator prompt (dispatch with `requestedSkills: playwright-skill`).
- The skill is **bundled** at `personas/web-tester/skills/playwright-skill/`
  (SKILL.md, run.js, lib/helpers.js, API_REFERENCE.md) — **without** node_modules.
- Playwright + Chromium are installed **globally in the Docker image**
  (`docker/Dockerfile`, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`).
- `run.js` was patched for the read-only mounted skill dir:
  - resolves global playwright via `npm root -g` (adds to `module.paths` + `NODE_PATH`)
  - writes temp scripts to `/tmp` (`PLAYWRIGHT_SKILL_TMP`), not the skill dir
  - defaults Chromium launches to `--no-sandbox` (the container is the sandbox;
    opt out with `PLAYWRIGHT_SKILL_SANDBOX=1`)
  - skips auto-install when `PLAYWRIGHT_SKILL_NO_INSTALL=1`

## Coordinator behavior rules (`coordinator.md`)

The coordinator's **sole mission** (encoded in the system prompt):
1. **Discover & refine** a product idea with the user (`ask_user`) until an
   actionable product specification is agreed — not invent major requirements
   in silence.
2. **Agree a plan** (architect for non-trivial work); break the release into
   specialist tasks with concrete success criteria.
3. **Drive the agent team** — maximize parallelism for independent work, keep
   review + test gates on every unit before integrate — until a **usable,
   tested release** exists.
4. **Do not stop early** — keep consulting architect / reviewers / testers and
   queue improvements until no further functional or technical progress is
   worth shipping for the goal, the user accepts done, or a stuck hard-stop needs
   human guidance. Stuck on one task ≠ project done.

Additional hard rules still encoded:
1. **Concrete success criteria** — every task/step must have objectively
   verifiable success criteria defined at dispatch time.
2. **Mandatory test-agent verification** — before completing any task, spawn a
   test agent to verify criteria (web → playwright). On failure, send the task
   back to the appropriate implementer for revision.
3. **Retry cap / stuck detection** — dispatch a given task a MAX of 10 times
   (initial + revisions). After 10, pause that task and `ask_user`; continue
   other work toward the release where possible.
4. Quality gates: every implementation reviewed AND tested before the integrator
   merges.

## Configuration (`shepherds-pi.yaml`)

Lives in the **target project** (not necessarily this repo). Template at
`templates/shepherds-pi.yaml`. Key fields:

- `project.repo_path` (default `.`), `dev_branch`, `main_branch`
- `docker.image` — **the agent image tag** (see "in sync" below)
- `openrouter.api_key` — usually `${OPENROUTER_API_KEY}` from `.env`
- `coordinator.model`, `coordinator.thinking_level`
- `personas_dir` — e.g. `./.shepherds-pi/personas`
- `agent.timeout_minutes`, `agent.max_retries`, `agent.git_token_env`
- `git.repo_mode`: **`worktree`** | `clone`
- `git.git_ops_mode`: **`host`** | `container`
  - Constraint: `git_ops_mode: host` REQUIRES `repo_mode: worktree`.
- `beads.enabled` (default **false**) — coordinator work-graph via host `bd`
  - When enabled: requires `bd` on PATH and `.beads/` in `beads.repo_path`
  - Unregisters free-form plan tools; every spawn must pass `beadId`
  - Design: `docs/beads-coordinator-design.md`

### Repo modes (critical)
- **worktree (mounted)** → spawner sets `REPO_MODE=mounted`, bind-mounts a git
  worktree at `/workspace/repo`. `GIT_URL` is **not** required.
- **clone** → spawner sets `REPO_MODE=clone`, container clones from `GIT_URL`
  (resolved from `GIT_URL` env or the origin remote). `GIT_URL` **is** required;
  a git token must be mounted.

### Git ops modes
- **host** → agents only change files; the host commits/pushes via
  `finalizeAgentChanges()` after the agent completes. Entrypoint is told NOT to
  run git in-container.
- **container** → the agent commits/pushes inside the container (needs token).

### Integration / merging (`merge_branch` tool)
- Cross-branch merges are **host git plumbing**, never done by the coordinator
  or an agent directly (agents can't run git in host mode — `.git` is a host
  worktree pointer). The coordinator calls the `merge_branch` tool.
- `merge_branch` (src/git/host-merge-manager.ts): `--no-ff` merge of
  `origin/<source>` into `origin/<target>` inside an ephemeral **detached**
  worktree under `worktrees_dir/.integration/`. Clean merges auto commit+push.
- On conflict it spawns the **integrator** persona as a resolver: the agent
  edits the conflicted files only (host does all git), then `finalizeMerge()`
  verifies no markers remain, commits the merge, pushes, and cleans up. Retries
  up to `MAX_CONFLICT_RESOLVE_ATTEMPTS` (3), else reports remaining conflicts.
- Gotcha baked into the code: `simple-git` does NOT throw on a merge *conflict*
  (only on hard errors), so the manager always inspects `status.conflicted`
  after the merge call rather than relying on catch.

## Docker agent container

- Image build context is the `docker/` dir: `docker build -t shepherds-pi-agent:latest -f docker/Dockerfile docker`
  (build files: `Dockerfile`, `entrypoint.sh`, `git-askpass.sh`).
- Base `node:20-bookworm`; installs `pi` globally + Playwright/Chromium.
- Security posture (`spawner.ts`): non-root uid 1000, `CapDrop: ALL`,
  `no-new-privileges`, read-only rootfs with explicit writable binds, mem/cpu/pids
  caps. Secrets (git token, OpenRouter key) delivered via tmpfs files in
  `/run/secrets`, never as env/argv.
- Mounts: persona at `/persona:ro`, instructions/context at `/tmp/*.txt:ro`,
  output at `/output`, secrets at `/run/secrets:ro`, worktree at
  `/workspace/repo` (worktree mode), shared meta-skill at
  `/shared-skills/using-agent-skills:ro`.
- `entrypoint.sh` (modes: `REPO_MODE` clone|mounted, `GIT_OPS_MODE` host|container)
  prepares the repo, builds the `pi` arg list (`--append-system-prompt SYSTEM.md`,
  one `--skill` per persona skill, the meta-skill, a summarize reminder), runs
  `pi --mode json --print "$INSTRUCTIONS"`, and ensures `/output/result.json`.
- The agent's result schema is produced by the persona's `summarize` skill
  (camelCase keys: `status`, `summary`, `filesCreated`, `testsPassed`, etc.).

## Keeping a TEST PROJECT in sync (read this!)

Three artifacts flow from this source repo into a target/test project and can
**drift independently**:

1. **CLI / coordinator code** — the global `shepherds-pi` is `npm link`'d to this
   folder but runs `dist/`. Changes to TS or `coordinator.md` require `npm run build`.
2. **Agent Docker image** — entrypoint/Playwright/personas-skills changes require
   rebuilding the image AND the project's `shepherds-pi.yaml` `image:` must point
   at that tag (NOT the stale published GHCR tag).
3. **Personas** — `shepherds-pi init` copies them ONCE into
   `<project>/.shepherds-pi/personas`; they are never auto-updated afterward.

**Use the sync script** (added for exactly this):

```bash
# from this repo
npm run sync -- <path-to-project>            # build CLI + image, sync personas, pin image
npm run sync -- <path-to-project> --no-docker  # skip image rebuild (persona/coordinator-only changes)
npm run sync -- <path-to-project> --no-build   # skip CLI build
npm run sync -- <path-to-project> --image <tag>
```

`scripts/sync-to-project.mjs`: runs `npm run build`, `docker build`, replaces the
project's `.shepherds-pi/personas`, and rewrites the `image:` line in the
project's `shepherds-pi.yaml` to the local tag. **It overwrites personas
wholesale** (source is the source of truth).

### Known drift trap (observed)
`GIT_URL not set` from a container = the project was using the **old published
GHCR image** whose entrypoint only knew clone mode, while the config used
`repo_mode: worktree`. Fix = sync (rebuild local image + pin `image:` to it).

## Build / test commands

```bash
npm run build        # clean + tsc (build:ts) + copy-assets (coordinator.md → dist)
npm run dev          # tsx src/cli.ts (run from source)
npm run docker:build # build shepherds-pi-agent:latest
npm test             # foundation + orchestrator + sanitize + worktree + host-git
npm run test:e2e     # worktree + clone handoff e2e (needs Docker)
npm run typecheck
```

`scripts/copy-assets.mjs` copies `src/orchestrator/coordinator.md` → `dist/...`.

### Development history + LLM usage tracking
- Every agent run's full transcript (raw pi `events.jsonl`) is archived in the
  `agent_transcripts` table, and token/cost totals are summed into `agent_runs`
  usage columns (`tokens_input/output/total`, `cost_usd`, `assistant_turns`,
  `usage_by_model`). Capture happens in `spawnAgent()` before workspace cleanup
  and is persisted by `executeAgentRun()` + the merge conflict-resolver path.
- Review it with `shepherds-pi history` (all runs) / `--run <id>` / `--cost`
  (rollup only) / `--json` / `--transcripts`.
- Usage is summed ONLY from `message_end` assistant events (see `agent/usage.ts`)
  — `message_start`/`message_update` also carry `usage` and would double-count.
- Coordinator (host pi) usage is NOT yet captured — only sub-agents. Its
  conversation lives in pi's own session store, not `shepherds.db`.
- Duplicate line format from a fresh install: migrations are additive; a fresh
  DB runs migration 1 then 2, an existing v1 DB just runs migration 2.
**After editing `coordinator.md`, run `npm run build` (or at least copy-assets).**

## Conventions & gotchas

- ESM project (`"type": "module"`); import paths use `.js` extensions in TS.
- `getModuleDir(import.meta.url)` is used to locate package assets; code resolves
  assets from `dist/` when built, `src/` in dev (see `cli.ts`).
- DB lives at `<repoPath>/.shepherds-pi/shepherds.db`; `.shepherds-pi/` and
  `.env` are gitignored (in target projects via `init`).
- The `edit` tool here requires each `edits[]` entry to have ONLY `oldText` /
  `newText` (no extra keys).
- On Windows + Git Bash, pass container paths with `MSYS_NO_PATHCONV=1` and use
  `pwd -W` for absolute host paths in `docker run -v` mounts.
- Don't reintroduce a `personas/web-tester;C` junk dir — it was an accidental
  shell path-mangling artifact and was removed.

## Useful entry points to read first
- `src/orchestrator/coordinator.md` — coordinator behavior
- `src/orchestrator/tools.ts` — what the coordinator can do
- `src/agent/spawner.ts` + `docker/entrypoint.sh` — how an agent actually runs
- `src/config/index.ts` — config shape and modes
- `personas/web-tester/` — the playwright testing setup
