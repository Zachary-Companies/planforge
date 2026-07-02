# PlanForge architecture

PlanForge turns an idea into shipped software in three user-facing steps:

1. **Preferences** — a one-time form captures which technologies the user likes
   for each kind of app (web, mobile, API, CLI, data). Output:
   `stack-preferences.json` (+ a rendered `TECH-PREFERENCES.md`).
2. **Plan** — a guided interview turns "what do you want to build?" into a
   build plan document (`plans/<slug>-build-plan.md`) in a strict house style:
   thesis → architecture → open decisions → phases of file-disjoint slices →
   status ledger. Plans are the single source of truth for what gets built.
3. **Run** — a continuous multi-agent pool builds the plan: a serialized
   planner keeps a buffer of disjoint slices topped up, K workers build them in
   parallel git worktrees (builder agent + reviewer agent per slice), each PR
   merges in a serial lane the moment it's review-clean, and a fix lane repairs
   failing/conflicting PRs. Branch hygiene runs after every merge pass.

A local web UI fronts all three steps and streams live run progress.

## Components (one directory each — they only touch each other via the contracts below)

| Dir | Owns | Entry |
|---|---|---|
| `core/` | orchestrator pool, review chain, provider selection/failover, branch hygiene | `core/orchestrator.mjs` |
| `planning/` | plan format spec, templates, interview + planner prompts, preferences schema | `planning/plan-format.md` |
| `ui/` | local web server + single-page app (dashboard, plan wizard, preferences form) | `ui/server.mjs` |
| `bin/` | `planforge` CLI: `init`, `plan`, `run`, `ui` | `bin/planforge.mjs` |

## Contracts

### 1. Config — `planforge.config.json` (lives in the user's workspace root)

```json
{
  "workspace": ".",
  "repos": ["owner/app-repo"],
  "plansDir": "plans",
  "preferences": "stack-preferences.json",
  "workers": 3,
  "fixWorkers": 1,
  "maxSlices": 12,
  "providers": {
    "builderPriority": ["codex", "claude"],
    "reviewerPriority": ["claude", "codex"]
  },
  "models": {
    "claude": "claude-fable-5",
    "claudeFallback": "claude-opus-4-8",
    "claudeEffort": "high",
    "codex": "gpt-5.5",
    "codexEffort": "high",
    "glm": "glm-5.2",
    "glmEffort": ""
  }
}
```

- `workspace` is the directory holding the target repo checkouts (paths resolve
  relative to the config file). Scratch dirs `.planforge/runs/` and
  `.planforge/worktrees/` live under it.
- `repos` are the repos the pool may touch. `plansDir` holds the build plans
  (relative to workspace; may itself be a git repo — if so, plan/status edits
  are committed through the same PR flow).
- Loader: `core/config.mjs` exports `loadConfig(pathOrDir)` → validated object
  with defaults applied. Everything downstream takes the config object; nothing
  reads env-specific defaults for repos/paths.

### 2. Run events — NDJSON stream

The orchestrator appends one JSON object per line to `<runDir>/events.ndjson`
(`runDir = <workspace>/.planforge/runs/<timestamp>/`) and mirrors them on
stdout prefixed `@event `. Event shapes (stable, additive-only):

```
{ "t": <ms>, "type": "run-start",      "workers": K, "budget": N, "repos": [...] }
{ "t": <ms>, "type": "plan-start",     "tag": "s001", "want": 2 }
{ "t": <ms>, "type": "plan-result",    "tag": "s001", "status": "queued|empty|saturated|provider-switch", "queued": 2, "ids": [...] }
{ "t": <ms>, "type": "seed-slices",    "count": 3, "ids": [...] }
{ "t": <ms>, "type": "launch",         "slot": 1, "sliceId": "...", "repo": "...", "title": "...", "kind": "feature|refactor|fix", "index": 4, "budget": 12 }
{ "t": <ms>, "type": "worker-done",    "slot": 1, "sliceId": "...", "ok": true, "branch": "worker-1/..." }
{ "t": <ms>, "type": "merge",          "label": "...", "merged": ["owner/repo#12"] }
{ "t": <ms>, "type": "fix-scan",       "found": 1, "queued": 1, "fixing": 0 }
{ "t": <ms>, "type": "provider-switch","builder": "codex", "reviewer": "claude", "demoted": ["glm"] }
{ "t": <ms>, "type": "stats",          "launched": 4, "budget": 12, "inFlight": 2, "queued": 1, "mergedPrs": 3, "mergedSlices": 3, "failed": 0, "fixing": 0, "fixQueued": 0, "fixed": 1, "dry": false, "elapsedMs": 12345 }
{ "t": <ms>, "type": "run-done",       "launched": 12, "mergedPrs": 10, "failed": 1, "fixed": 2 }
```

The UI server tails `events.ndjson` and re-emits over Server-Sent Events at
`GET /api/runs/:id/events`. The UI never imports core code — it spawns
`node core/orchestrator.mjs` / `bin/planforge.mjs run` as a child process.

### 3. Plan documents — `plans/<slug>-build-plan.md`

Authoritative spec in `planning/plan-format.md`. Non-negotiables:

- `## 1. Overview` (thesis, users, definition of done)
- `## 2. Architecture` (repo layout, stack — MUST reference the user's
  stack preferences and record deviations)
- `## 3. Open decisions` — `D1..Dn`, each `Proposed | Accepted | Blocked`,
  with the question, options, recommendation. **Slices gated on a non-Accepted
  decision are not buildable.**
- `## 4. Phases` — `### Phase N — <name>`; each phase lists slices:
  `id`, `title`, `paths` (file-disjointness is what makes parallel building
  safe), `status` (`pending | building | shipped | blocked-on-Dx`), acceptance
  criteria.
- `## 5. Status ledger` — append-only `verified against <sha> <date>` rows;
  reconcile passes update slice statuses here, never rewrite history.

The planner agent reads every plan in `plansDir` + `stack-preferences.json`
and returns the next K unblocked, mutually file-disjoint slices as JSON.

**Plan pipeline** (`planforge plan`): a plan is not one agent call — it is
draft → **deepen** (expand architecture and every slice until it is
implementation-ready; unknowns become decisions, never fiction) → **N
consistency-review passes** (default 2; a checklist-driven reviewer either
replies `PLAN-CONSISTENT` or returns the corrected doc — the loop stops early
on the marker) → **write + git** (the plan file is committed when `plansDir`
is a git repo) → **scaffold** (create the project folder named by the wizard's
`project-folder` answer or `--dir`, seed README/.gitignore from the plan,
`git init -b main` + initial commit, and optionally `gh repo create … --push`
per the `github-repo` answer or `--remote`, registering the new repo in
`planforge.config.json`). Scaffolding is never destructive: an existing
non-empty directory is left untouched. Stage transitions are announced on
stdout as `@plan-stage <name>` lines; the final `@plan-slug <slug>` marker
names the written plan. Prompt builders live in `planning/prompts.mjs`
(`buildInterviewPrompt`, `buildDeepenPrompt`, `buildConsistencyReviewPrompt`,
`buildRevisePrompt`); folder/git mechanics in `core/scaffold.mjs`.

### 4. Preferences — `stack-preferences.json`

Schema in `planning/preferences-schema.json`. Shape:

```json
{
  "version": 1,
  "general":  { "languages": ["typescript"], "packageManager": "npm", "license": "MIT", "testing": "vitest", "ci": "github-actions" },
  "webApp":   { "framework": "react", "meta": "vite", "styling": "tailwind", "backend": "node-express", "db": "postgres", "auth": "…", "hosting": "…" },
  "mobileApp":{ "framework": "react-native-expo", "…": "…" },
  "api":      { "framework": "fastify", "db": "postgres", "…": "…" },
  "cli":      { "language": "typescript", "…": "…" },
  "data":     { "language": "python", "…": "…" },
  "freeform": "anything else the user wants agents to honor"
}
```

Every field is optional; the form UI writes it; the interview and planner
prompts inject a rendered summary of it.

### 5. Agent providers

A provider is any CLI that reads a prompt on stdin, works in the cwd, and
exits 0/non-0 (`core/agents/agent-claude.sh`, `agent-codex.sh`; users add
their own by dropping `agent-<name>.sh` and listing it in config). Builder and
reviewer are selected by priority with reactive failover on quota/rate-limit
signatures; builder ≠ reviewer unless only one provider is available (claude
may fill both).

## Provenance

The core is a genericized extraction of a private orchestrator that has been
merging real PRs across a multi-repo codebase for weeks: continuous pool,
serial merge lane, fix lane, seed slices, provider failover, review gate
(drafts are never force-readied), and post-merge branch hygiene are inherited
behaviors with the project-specific repos/paths/prompts made config-driven.
