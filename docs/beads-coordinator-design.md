# Beads Integration Design — Coordinator Work Graph

**Status:** Design accepted for Phase 1 implementation. Locked decisions below.  
**Goal:** Make Beads the coordinator’s plan-of-record for workplans and tasks.  
**Non-goal:** Replace SQLite run/execution state, or give specialist agents Beads write access.

Related background: [gastownhall/beads](https://github.com/gastownhall/beads) (`bd` CLI).

### Locked decisions (2026-07-11)

| Topic | Decision |
|---|---|
| Close policy | **Option B (pipeline)** — implement closes when work is delivered + host-git finalize OK; review/test block integrate only |
| Labels | Taxonomy in §3.2 accepted as-is |
| Tool surface | List in §5.1 accepted as-is |
| Specialists | Host-only Beads writes; agents never mutate `.beads` |
| Dual plan | When `beads.enabled`, unregister `read_plan` / `update_plan` |

---

## 1. Problem

Today the coordinator has two weak planning primitives:

| Mechanism | Location | Weakness |
|---|---|---|
| Free-form plan JSON | `read_plan` / `update_plan` → SQLite `plans` | No deps, no ready-queue, no claim/close lifecycle, easy to rewrite inconsistently |
| Run log | `read_run_log` → SQLite `run_log` | Good narrative memory; bad work graph |

Coordinator behavior already *implies* a graph (implement → review → test → integrate, blockers, retry caps) but encodes it only in prompt prose and whatever JSON the model invents.

## 2. Decision

**Beads owns the durable work graph. SQLite owns run / execution state.**

```
User goal
    │
    ▼
Coordinator (host `pi` process)
    ├─ Beads (host `bd` CLI, project `.beads/`)
    │     epics, tasks, deps, claims, closes, acceptance, memories
    │
    └─ Orchestrator tools (existing + thin Beads wrappers)
          spawn_agent(s), branches, host-git finalize, run_log, ask_user
          SQLite: runs, agent_runs, run_log, goal status
```

Rules of ownership:

1. **Beads is the only plan of record** when the feature is enabled.
2. Specialists **never write** Beads. Only the coordinator (host) does.
3. **SQLite run_log stays** for orchestration events (`agent_started`, `agent_completed`, finalization errors, status changes).
4. Every dispatchable unit of work has a **bead id**. Spawns reference it.

Feature flag (proposed config):

```yaml
beads:
  enabled: true                 # default false until baked in
  binary: bd                    # PATH lookup, overrideable
  repo_path: .                  # where `.beads/` lives (usually project.repo_path)
  require_bead_on_spawn: true   # enforce beadId on spawn_agent when enabled
  stuck_dispatch_limit: 10      # mirrors coordinator.md retry cap
```

When `beads.enabled: false`, keep current `read_plan` / `update_plan` behavior unchanged.

---

## 3. Graph model

### 3.1 Issue types we use

| Beads `issue_type` | Shepherds meaning | Notes |
|---|---|---|
| `epic` | One user goal / workplan for a run | One open goal-epic per active run when possible |
| `task` | Dispatchable unit of work | Implement, review, test, integrate, schema, etc. |
| `bug` | Verification/regressions found post-merge or by tester that are out of the original task scope | Optional; can also be a `task` with label `rework` |
| `feature` | Prefer **not** to use | Overlaps epic; keep types tight |

### 3.2 Labels (required taxonomy)

Use labels for routing and filtering. Do not encode persona only in free text.

| Label | Purpose |
|---|---|
| `role:implement` | Produces code/schema/content changes |
| `role:review` | Code-review quality gate |
| `role:test` | Verification of success criteria |
| `role:integrate` | Merge into dev/main |
| `role:plan` | Architect analysis / plan breakdown (usually pre-epic children) |
| `persona:<name>` | e.g. `persona:typescript-api-dev`, `persona:web-tester` |
| `gate:review` | Marker that this bead is the review gate for a unit |
| `gate:test` | Marker that this bead is the test gate for a unit |
| `rework` | Created or reopened because verification failed |
| `blocked-user` | Waiting on `ask_user` / human decision |

### 3.3 Structured body fields (template)

Every **dispatchable task** bead body/description MUST include machine-readable sections. Coordinator tools should validate on create/update (soft-fail with warning, hard-fail once stable).

```markdown
## Objective
<one paragraph>

## Success criteria
- [ ] <objectively verifiable criterion 1>
- [ ] <criterion 2>

## Persona
typescript-api-dev

## Branch
feat/auth-login

## Skills
playwright-skill   # optional; empty if none

## Context
<anything the specialist needs; keep short; link parent epic id>

## Evidence required
self-report | review-notes | playwright | logs | diff
```

Prefer Beads native fields when available:

- `bd update <id> --acceptance "..."` for success criteria (primary)
- `--notes` for dispatch history / rework notes
- `--description` for objective + context
- title for short human label

**Canonical success criteria location:** `--acceptance` if supported by installed `bd`; otherwise the `## Success criteria` section in description. Tool layer normalizes to one shape in JSON returned to the model.

### 3.4 Hierarchy

Prefer hierarchical IDs (Beads native) for epics:

```
bd-a3f8                 epic: "Add OAuth login"
bd-a3f8.1               task implement: API token endpoint   role:implement
bd-a3f8.2               task implement: login UI             role:implement
bd-a3f8.1.1             task review: API token endpoint      role:review
bd-a3f8.1.2             task test: API token endpoint        role:test
bd-a3f8.3               task integrate: merge OAuth work     role:integrate
```

If hierarchical create is awkward in wrapping, use flat IDs + **parent-child deps** (`dep add` parent-child). Either is fine as long as:

- every non-epic task has a parent epic (or explicit parent task)
- gates are explicit child tasks, not implicit prompt rules only

### 3.5 Dependencies (the quality-gate graph)

**Default unit of implementation** is a *triplet* (or quadruplet with integrate):

```
implement  ──blocks──▶  review
implement  ──blocks──▶  test
review     ──blocks──▶  integrate   (if unit merges alone)
test       ──blocks──▶  integrate
```

Semantics (Beads `blocks` edge: parent blocks child until closed — confirm exact `bd dep add` direction against installed CLI; **wrapper normalizes** so tool API is always):

```text
beads_dep({ from: implementId, to: reviewId, type: 'blocks' })
// meaning: review is not ready until implement is closed
```

**Integrator epic-level bead** is blocked by all per-unit review+test beads (or by intermediate “unit done” bookmark beads if the graph gets wide).

**Planning tasks** (`role:plan`, architect) have no implement deps; their output is *creating* the epic children via coordinator after architect returns.

### 3.6 Status lifecycle

| Status | Who sets it | Meaning |
|---|---|---|
| `open` | create | Exists; may be blocked by deps |
| `in_progress` | `claim` on dispatch | Coordinator currently owns this for a spawn |
| `closed` | close after satisfactory result | Done; unblocks dependents |
| `blocked` (or open + `blocked-user` label) | stuck limit / needs human | Do not auto-dispatch |

Coordinator does **not** invent a parallel status enum. Map `update_goal_status` (run-level) separately from bead status.

### 3.7 Rework model

When test or review fails:

1. Do **not** close the implement bead early. Prefer: implement stays open or is reopened.
2. Append findings to implement bead notes (or create a child `rework` task blocked by nothing but parent-linked).
3. Increment a **dispatch count** recorded on the bead (see §5.3).
4. Review/test beads for that unit remain open until they themselves succeed.
5. After successful re-implement, re-dispatch the existing review and/or test beads (re-claim), do not spawn free-floating agents without bead ids.

**Recommended:** keep one stable implement bead id across retries. Open append-only rework notes rather than new implement beads unless scope splits.

### 3.8 Stuck detection

For a given **implement** bead id (or “responsible” bead for the unit):

- Each `spawn_agent` / entry in `spawn_agents` that targets that bead counts as **1 dispatch**.
- Reviewer and tester spawns count against their own bead ids, not the implement id (limits game-ability).
- If implement dispatches ≥ `stuck_dispatch_limit` (default 10) without close → set blocked / `blocked-user`, stop auto-loop, `ask_user` with summary of notes + last failures.

Tool layer can enforce by reading notes/metadata `shepherd.dispatch_count` before spawn.

### 3.9 Memory vs work

| Tool | Use for |
|---|---|
| `bd remember` / `bd prime` | Durable project insights (conventions, ports, “always run X”) |
| Beads issues | Work items for the current (and residual) goals |
| SQLite run_log | This run’s orchestration timeline |

Coordinator should call prime at run start and after compaction; should **not** dump the whole epic into remember.

---

## 4. Coordinator control loop (policy)

Replace “rewrite plan JSON” with:

```
on goal:
  1. beads_prime
  2. Create or resume goal epic (beads_create / beads_show)
  3. If graph empty → spawn architect (plan bead) OR decompose into tasks if trivial
  4. Materialize tasks + deps from plan (beads_create_many + beads_dep)
  5. Loop until epic closeable or user aborts:
       a. beads_ready
       b. Select ready beads (respect parallel safety + resource limits)
       c. For each chosen bead:
            - beads_claim
            - synthesize agent instructions from show + acceptance
            - spawn_agent / spawn_agents with beadId
       d. On agent result:
            - log to run_log (always)
            - map result → close / reopen / notes / new deps
            - if gate failed → rework path (§3.7)
            - if stuck → ask_user
  6. Close epic when all children closed; update_goal_status completed
```

### 4.1 Hard rules (for `coordinator.md`)

These should be near-verbatim in the prompt when Beads is enabled:

1. **Plan of record:** Beads is the only workplan. Do not maintain markdown TODO lists or free-form `update_plan` JSON as a second plan.
2. **Every spawn has a bead:** `spawn_agent` / each agent in `spawn_agents` MUST include `beadId`. If you lack one, create the task bead first.
3. **Ready before claim:** Prefer work from `beads_ready`. Do not claim blocked beads.
4. **Success criteria first:** Never create an implement bead without acceptance criteria. Never spawn implement without putting those criteria in agent instructions.
5. **Gates are beads:** Review and test are first-class beads that block integrate/close of the unit. Self-report by implementer is never sufficient to close a test bead.
6. **Evidence:** Close a test bead only when the tester’s result verifies the acceptance criteria (playwright for web). Paste/summarize evidence into notes when closing.
7. **Parallelism:** Only spawn in parallel for beads that are simultaneously ready and do not contend on the same branch/files. Prefer one writer per branch.
8. **Host git mode:** Still no commit/push by agents when `git_ops_mode: host`. Closing an implement bead means “file changes + host finalize succeeded,” not “agent claimed commit.”
9. **Stuck cap:** Max 10 implement dispatches per implement bead without close → stop and ask_user.
10. **User blockers:** Prefer `ask_user` + label `blocked-user` over inventing product decisions.

### 4.2 Instruction synthesis (spawn payload)

When spawning from a bead, coordinator builds instructions deterministically:

```text
Bead: <id> — <title>
Parent epic: <epic id> <title>

Objective:
...

Success criteria (MUST meet):
- ...

Branch: ...
Requested skills: ...

Your job:
- Perform the work for role <role:*>
- Do not expand scope beyond this bead
- Leave evidence for the next gate described above

Prior notes / rework:
...
```

Pass optional structured context blob (JSON) in `context` including `{ beadId, epicId, acceptance, branch, role }`. Tools may auto-inject if the model forgets.

### 4.3 Architect flow

1. Create `role:plan` bead under/at epic (or epic alone open).
2. Spawn architect claimed on that plan bead.
3. Architect returns decomposition in `result.json` summary (not Beads writes).
4. Coordinator creates implement/review/test/integrate beads + deps.
5. Close plan bead once graph materialization matches the plan.
6. If architect is wrong, rework the plan bead or edit the graph explicitly; do not keep a parallel JSON plan.

### 4.4 Completed definition

- Epic may close only when all required children are closed.
- Goal status `completed` only when epic is closed (or user accepts a reduced scope and remaining open beads are cancelled/closed with reason).
- Cancelling work: close with reason `cancelled: ...` rather than deleting (audit trail).

---

## 5. Tool surface

All Beads tools run **host-side**, via a small `BeadsClient` that shells out to `bd --json` (or equivalent JSON flags). Never ask the coordinator to raw-shell `bd` for plan mutations (optional later diagnostic escape hatch only).

### 5.1 Proposed tools

| Tool | Purpose | Maps roughly to |
|---|---|---|
| `beads_prime` | Workflow context + memories for the model | `bd prime` |
| `beads_ready` | List unblocked open work | `bd ready --json` |
| `beads_show` | Detail + audit + deps for one id | `bd show <id> --json` |
| `beads_create` | Create one issue | `bd create ...` |
| `beads_create_many` | Batch create (planning materialization) | N× create (transactional best-effort) |
| `beads_update` | Title/description/acceptance/notes/labels/priority | `bd update ...` |
| `beads_claim` | Mark in_progress for spawn | `bd update <id> --claim` |
| `beads_close` | Close with reason | `bd close <id> "..."` |
| `beads_reopen` | Reopen failed unit | `bd update --status open` (or CLI reopen) |
| `beads_dep` | Add/remove dependency | `bd dep add/remove` |
| `beads_remember` | Store durable memory | `bd remember "..."` |
| `beads_list` | List by epic/label/status | `bd list` filters |

**Not exposed initially:** `bd edit` (interactive), prune/purge, dolt push/pull, init (handled by setup), $"/mail/molecules.

### 5.2 Parameter schemas (Typebox-level)

```ts
// beads_create
{
  title: string,
  type?: 'epic' | 'task' | 'bug',       // default task
  priority?: 0 | 1 | 2 | 3 | 4,        // default 2
  description?: string,
  acceptance?: string,                 // success criteria
  labels?: string[],                   // see §3.2
  parentId?: string,                   // epic or parent task
  branch?: string,                     // stored in body or metadata
  persona?: string,                    // auto-adds persona:* label
  role?: 'implement' | 'review' | 'test' | 'integrate' | 'plan',
}

// beads_claim
{ id: string, assignee?: string }      // assignee default "coordinator"

// beads_close
{ id: string, reason: string, evidence?: string }

// beads_dep
{
  from: string,                        // blocker
  to: string,                          // blocked issue
  type?: 'blocks' | 'parent-child' | 'relates_to',
  action?: 'add' | 'remove',           // default add
}

// beads_ready
{
  label?: string,                      // filter e.g. role:implement
  limit?: number,
}

// beads_update
{
  id: string,
  title?: string,
  description?: string,
  acceptance?: string,
  notesAppend?: string,                // tool appends with timestamp
  addLabels?: string[],
  removeLabels?: string[],
  priority?: number,
  status?: string,
}

// beads_create_many
{ items: Array</* beads_create shape */> }
```

### 5.3 Spawn API changes

Extend existing spawn params:

```ts
const SpawnAgentParams = Type.Object({
  persona: Type.String(),
  instructions: Type.String(),
  branch: Type.Optional(Type.String()),
  context: Type.Optional(Type.String()),
  beadId: Type.Optional(Type.String({
    description: 'Beads task id this spawn fulfills (required when beads.enabled)',
  })),
  requestedSkills: Type.Optional(Type.Array(Type.String())),
});
```

Enforcement in tool handler when `config.beads.enabled && config.beads.requireBeadOnSpawn`:

1. Reject missing `beadId`.
2. `bd show` the bead; reject if not found, closed (unless reopen path), or blocked by open deps.
3. Increment/store `shepherd.dispatch_count` (notes metadata or label `dispatch:N` — prefer notes JSON sidecar line).
4. Reject if implement-role and dispatch_count > limit.
5. Prefer auto-claim if not already in_progress.
6. Append spawn event to bead notes: `spawn <agentRunId> persona=... at <ts>`.
7. On completion path inside spawn tool (after result):
   - append result summary to notes  
   - do **not** auto-close (coordinator decides; model must call `beads_close`)  
   - still write SQLite agent_runs + run_log as today  

**Why not auto-close on agent success?** Close is a quality decision (especially for gates). Auto-close would let implement self-report close the bead without review/test.

### 5.4 Tool result shape (stable JSON to the model)

Every Beads tool returns text JSON roughly:

```json
{
  "ok": true,
  "command": "ready",
  "data": [ /* native bd json, lightly normalized */ ],
  "normalized": {
    "issues": [
      {
        "id": "bd-a3f8.1",
        "title": "...",
        "status": "open",
        "priority": 1,
        "labels": ["role:implement", "persona:typescript-api-dev"],
        "acceptance": "...",
        "blockedBy": [],
        "blocks": ["bd-a3f8.1.1", "bd-a3f8.1.2"],
        "dispatchCount": 2
      }
    ]
  }
}
```

Normalization protects `coordinator.md` from `bd` output churn.

### 5.5 Plan tools under Beads mode

| Tool | When `beads.enabled` |
|---|---|
| `update_plan` | **Deprecated / no-op with error guidance** → “use beads_create / beads_create_many” |
| `read_plan` | **Compatibility shim**: synthesize a plan view from epic+children via `bd list` | or remove from registration entirely when enable |

Recommendation: **unregister** `read_plan`/`update_plan` when Beads enabled so the model cannot dual-write.

### 5.6 UI / status widget

`/shepherd-status` and status widget should show:

- goal epic id + title + status  
- counts: ready / in_progress / blocked / closed  
- last N run_log events (unchanged)  
- stuck beads (dispatchCount high or `blocked-user`)

---

## 6. Host integration details

### 6.1 `BeadsClient` module (proposed path)

`src/beads/client.ts`

Responsibilities:

- resolve binary (`config.beads.binary`)
- run with `cwd = beads.repo_path || project.repo_path`
- always request JSON
- timeout + kill
- map `bd` failures to structured tool errors
- serialize writes through a **mutex** (embedded Dolt single-writer)

`src/beads/normalize.ts` — map CLI JSON → `normalized` shape.  
`src/beads/templates.ts` — description/acceptance builders, label helpers.  
`src/beads/dispatch-count.ts` — parse/append dispatch metadata in notes.

### 6.2 Init / doctor / setup

| Command | Change |
|---|---|
| `shepherds-pi doctor` | If beads enabled: `bd` on PATH, `bd version`, `.beads` exists or warn, schema/health via `bd doctor` if available |
| `shepherds-pi init` | Optional `bd init` in target project (prompt or flag `--with-beads`) |
| `shepherds-pi setup` | Document `bd` as host prereq; do **not** install into agent image for v1 |

Stealth mode: support `bd init --stealth` for users who do not want `.beads` committed; config `beads.stealth: true`.

### 6.3 Git / worktrees / containers

v1 constraints:

- Beads DB lives on **host project root**, not per-worktree clone of truth (embedded under main repo `.beads/`).
- Agent containers do **not** mount `.beads` writable.
- Worktree agent checkouts may omit `.beads` entirely.
- Host coordinator always uses main repo path for `bd` cwd.

This avoids multi-writer and dirty worktree issues.

### 6.4 Run DB linkage

Optional SQLite columns/events (non-blocking recommendation):

- `runs.beads_epic_id TEXT`
- run_log events: `bead_created`, `bead_claimed`, `bead_closed`, `bead_blocked`
- `agent_runs.bead_id TEXT`

Lets status UI join execution with work graph without pure-JSON scrapes.

---

## 7. Coordinator.md deltas (draft sections)

When implementing, add/replace:

```markdown
## Work Graph (Beads)

- Beads (`beads_*` tools) is the plan of record for this project.
- At start (and after context compaction), call beads_prime and review beads_ready.
- Model work as an epic with task children; express quality gates as review/test beads
  that block integrate.
- Every spawn_agent call MUST include beadId for an open, claimable task bead.
- Put success criteria in the bead acceptance field AND in agent instructions.
- Close beads only with evidence. Close test beads only after verification agents pass.
- Use beads_remember for durable project insights; use read_run_log for this-run timeline.
- Do not use update_plan / markdown TODOs for task tracking.
```

Retain existing quality gates and 10-dispatch stuck rule; restate them in bead terms (§3.7–3.8).

---

## 8. Example: small feature graph

Goal: “Add GET /health that returns {ok:true}”

```
epic  bd-heal     "Add /health endpoint"
├─ task bd-heal.1   plan/architect (optional if trivial — can skip)
├─ task bd-heal.2   implement API     labels: role:implement, persona:typescript-api-dev
│    acceptance: "GET /health → 200 JSON {ok:true}; covered by unit or e2e"
├─ task bd-heal.3   review API        labels: role:review, persona:code-reviewer, gate:review
├─ task bd-heal.4   test API          labels: role:test, persona:web-tester (or api tester), gate:test
└─ task bd-heal.5   integrate         labels: role:integrate, persona:integrator

deps:
  bd-heal.2 blocks bd-heal.3
  bd-heal.2 blocks bd-heal.4
  bd-heal.3 blocks bd-heal.5
  bd-heal.4 blocks bd-heal.5
```

Ready after create: only `bd-heal.2` (and plan if any).

Flow:

1. claim+spawn implement on `.2`  
2. finalize host git → notes evidence  
3. coordinator does **not** close `.2` until review *and* test policy is settled  

   **Close policy: Option B (pipeline) — ACCEPTED.**

   - Close implement when “changes delivered + host finalize ok”; review/test are independent gates for integrate only.
   - Implement close means “implementation work delivered,” not “shipped.”
   - Integrate still requires review+test closed.
   - Epic close requires integrate closed (or all gates if no separate integrate).

Document Option B as the required default in `coordinator.md`.

---

## 9. Failure modes and guardrails

| Risk | Mitigation |
|---|---|
| Dual plan (JSON + beads) | Unregister plan tools when enabled |
| Model raw-shells `bd` inconsistently | Prefer tools only; prompt forbids planning via shell |
| Embedded Dolt lock conflicts | Host-only writer + mutex |
| Agents dirty `.beads` | Do not mount writable |
| Infinite rework | dispatch_count + stuck tool check + ask_user |
| Close without evidence | Prompt + optional tool warning if close reason empty / test close without agent_run scrub |
| `bd` CLI schema drift | normalize layer + version pin in doctor |
| Huge prime context | limit ready list; compact closed; run_log filter still available |
| Branch contention | one in_progress implement per branch (tool check soft warning) |
| Windows path / PATH issues | doctor; config.binary absolute path |

---

## 10. Migration strategy

### Phase 0 — spike (manual)
- Install `bd`, init in a test project, hand-run Option B pipeline with existing spawn tools and note CLI JSON shapes.

### Phase 1 — tools + prompt (this design)
- Implement `BeadsClient` + tools listed in §5.
- Config flag default **off**.
- `coordinator.md` section behind flag or dual prompt fragments.
- Doctor checks.
- Unregister plan tools when on.
- Spawn `beadId` optional unless require flag.

### Phase 2 — default-on for new inits
- `init --with-beads` default true.
- Status widget epic summary.
- SQLite bead_id columns.
- Enforcement of dispatch_count hard fail.

### Phase 3 — optional niceties
- Auto-inject bead context into agent instructions inside spawn tool.
- Read-only bead summary for specialists (copy into instructions; still no container `bd`).
- Import legacy SQLite plans once into beads on first enable.
- Compaction policy for long projects.

---

## 11. Explicit non-goals (v1)

- Beads inside Docker agents  
- Multi-coordinator multi-writer (server mode)  
- Replacing `run_log`  
- Replacing host-git finalize with issue-tracker driven merge  
- Full MOL/mail/molecule workflows  
- User-facing product issue tracker for humans (incidental benefit only)

---

## 12. Open questions

### Resolved

| # | Topic | Resolution |
|---|---|---|
| 5 | Close policy | **Option B (pipeline)** |
| — | Labels | Accepted §3.2 |
| — | Tool list | Accepted §5.1 |

### Resolved during Phase 1 implementation

| # | Topic | Resolution |
|---|---|---|
| 1 | Dep edge direction | Tool API `from` blocks `to` maps to `bd dep <from> --blocks <to>` |
| 2 | Hierarchical create | Uses `bd create --parent <id>` (produces `epic.N` children) |
| 3 | JSON flags | Requires `bd` with global `--json` (verified on 0.48.0+); doctor checks binary |
| 4 | Commit `.beads` | Default in-project `.beads` (users may `bd init --stealth`) |
| 5 | Epic per goal | Prompt: one goal epic per goal (multi-epic allowed if user stacks goals) |
| 6 | Auto-claim on spawn | Yes — `prepareBeadForSpawn` claims + increments dispatch count |

### Still open (resolve during Phase 1 spike / implementation)

1. **Dep edge direction:** Confirm with installed `bd dep add --help` whether `bd dep add <child> <parent>` means child blocked-by parent; bake correct direction into `beads_dep` so the tool API stays `from blocks to`.
2. **Native hierarchical create:** Prefer `bd create --parent` style if available; else flat + parent-child deps.
3. **JSON flags:** Pin required minimum `bd` version that supports stable `--json` on ready/show/create/close.
4. **Commit `.beads`?** Default **yes** for shepherds-managed product repos; stealth opt-in for private coordinator use on shared codebases. *(design default)*
5. **Epic per run vs multi-goal:** Default one epic per goal message; allow multiple open epics only if user stacks goals deliberately. *(design default)*
6. **Should `beads_claim` be automatic inside spawn?** Default yes when `beadId` provided; still expose claim tool for manual recovery. *(design default)*

---

## 13. Acceptance criteria for the design itself

This design is ready to implement when:

- [x] Option B (pipeline close) accepted  
- [x] Tool list accepted (or trimmed)  
- [x] Label taxonomy accepted  
- [x] Spawn requires beadId when enabled  
- [x] Host-only writer constraint accepted  
- [x] Plan tools deprecated when enabled  
- [x] Remaining open questions §12 time-boxed to Phase 1 spike defaults  

---

## 14. Suggested Phase 1 file touch list (preview)

| Path | Change |
|---|---|
| `src/beads/client.ts` | new |
| `src/beads/normalize.ts` | new |
| `src/beads/types.ts` | new |
| `src/orchestrator/tools.ts` | register beads tools; spawn beadId; conditional plan tools |
| `src/orchestrator/coordinator.md` | work graph section + rewrite plan language |
| `src/orchestrator/coordinator-beads.md` | optional include fragment |
| `src/config/index.ts` | `beads` config block |
| `templates/shepherds-pi.yaml` | beads section |
| `src/commands/doctor.ts` | bd checks |
| `src/db/index.ts` | optional bead_id columns |
| `src/extensions/shepherds/index.ts` | status widget counts |
| `src/test/beads-*.ts` | client mock tests |
| `docs/beads-coordinator-design.md` | this file |

---

## 15. Summary

Beads becomes the coordinator’s **dependency-aware work graph and external planning memory**. SQLite remains the **run engine ledger**. The coordinator loops on `ready → claim → spawn → interpret → close/reopen`, with review/test modeled as real blockers under pipeline close semantics. Specialists stay pure workers; only the host coordinator mutates Beads through typed tools.
