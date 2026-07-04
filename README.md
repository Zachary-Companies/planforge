# PlanForge

**Idea → plan → shipped software.** PlanForge is a local tool that helps you
turn "I want an app that…" into a rigorous build plan, then builds that plan
with a pool of parallel coding agents — planned, reviewed, merged, and cleaned
up, end to end.

It has three parts, all driven from a local web UI:

1. **Tell it what you like.** A one-time preferences form asks which
   technologies you prefer for different kinds of apps (web, mobile, API, CLI,
   data). Don't know or don't care? Pick "No preference" and PlanForge chooses
   boring, mainstream defaults — and records every choice it made for you.
2. **Turn your idea into a plan.** A guided interview asks what you're
   building, who it's for, and what "done" means — then writes a build plan in
   a strict, agent-friendly format: an overview, the architecture, explicit
   **open decisions** that gate work until you accept them, and phases of
   small, file-disjoint slices a single worker can finish in one PR. The plan
   isn't a one-shot draft: a second pass digs into the details until every
   slice is implementation-ready, then consistency reviewers go over it a
   couple of times to find and fix contradictions. When the plan is done,
   PlanForge sets up the project folder for you — README and .gitignore seeded
   from the plan, git initialized with a clean first commit, and (if you say
   yes) a GitHub repository created and registered so the build pool can open
   pull requests against it.
3. **Run the pool.** A continuous orchestrator keeps a buffer of unblocked
   slices topped up, K workers build them in parallel git worktrees (one agent
   builds, a second agent reviews), each PR merges in a serial lane the moment
   it's review-clean, a fix lane repairs failing or conflicted PRs, and branch
   hygiene runs after every merge — no abandoned branches, no force-readied
   drafts, no unreviewed merges. When the plan work drains, a **verify pass**
   runs the project's own `build` and `test` and spends remaining budget
   repairing any failure — so a finished run is built, tested, and green, not
   just merged (`--no-verify` to skip).

   Hit a broken build or a failing test on its own? **`planforge fix`** (or the
   **Fix with the build pool** button on a failed action) points the pool
   straight at it — build and test, then diagnose → repair → re-verify until
   they pass, without touching the plan.

   Want to add a feature later? Open the plan and use **Add features & refine**
   (or `planforge plan --revise`): it applies your change and runs the full
   deepen + consistency-review pipeline, then the pool builds it.

4. **Run, build, ship, and set up its resources.** When the pool has built
   your app, the **Projects** tab gives you **Start / Build / Set up resources
   / Publish** buttons. PlanForge reads the commands straight from your
   project — its `package.json` scripts and infra config (`firebase.json`,
   `docker-compose.yml`, `prisma/`, `vercel.json`, `*.tf`…) — so Start runs the
   dev server (with a clickable link when it detects one), **Set up resources**
   provisions the databases/storage/etc. the app needs, and Publish deploys to
   the host it finds. Same from the terminal: `planforge start`, `build`,
   `provision`, `publish`. Override any command in `planforge.config.json`
   under `"projects"`.

   Provisioning uses **your** cloud account. Most providers gate the very first
   creation of a database or storage bucket behind a one-time click in their
   console (to pick a region and, sometimes, enable billing). When PlanForge
   hits that, it shows you the exact console link and a "Try again" button —
   do the one-time step, and it finishes the rest.

## Quick start

```bash
# in the directory that holds (or will hold) your project checkouts:
npx planforge init      # writes planforge.config.json + plans/
npx planforge ui        # opens the local UI: preferences → plan → run
```

Or from the CLI without the UI:

```bash
planforge plan --answers answers.json   # interview answers -> plans/<slug>-build-plan.md
planforge run --max-slices 12           # build everything unblocked, 3 workers
```

### Requirements

Works on **macOS, Linux, and Windows**.

- Node.js ≥ 20. No npm dependencies — the whole tool is standard library.
- `git` and the GitHub CLI (`gh`), authenticated for your target repos.
  On Windows, install [Git for Windows](https://git-scm.com/download/win) —
  PlanForge uses its bundled bash for composed commands (the agents themselves
  are Node scripts and need no shell).
- At least one coding agent (two is better — one writes, one reviews).

Run `planforge doctor` to check all of it at once — it tells you exactly
what's missing and how to fix it.

### Bring your own agents

Three providers work out of the box; set up the ones you have accounts for:

| Agent | Setup |
|---|---|
| **Claude** (Claude Code) | `npm install -g @anthropic-ai/claude-code`, then run `claude` once to sign in |
| **Codex** (OpenAI) | install the Codex app or CLI and sign in |
| **GLM 5.2** (z.ai) | `export ZAI_API_KEY=...` (or save it once in `~/.config/zai/env`) |

**Picking models and effort:** every provider's model id and reasoning effort
live in `planforge.config.json` under `models` (Claude also has a fallback
model for when the primary is gated). Edit them in the UI's run panel under
"Models & effort", or override per run:
`planforge run --model claude=claude-opus-4-8 --effort codex=medium`. The plan
wizard accepts `planforge plan --model <id> --effort <level>` too.

**Picking who writes and who reviews:** by default PlanForge auto-selects from
what's available (writer prefers Codex → GLM → Claude; reviewer prefers
Claude → Codex → GLM) and fails over automatically when a provider runs out
of credits mid-run. To choose yourself: use the **Code writer** and
**Reviewer** dropdowns in the UI's run panel, or
`planforge run --builder glm --reviewer claude`, or reorder the priority
lists in `planforge.config.json`. Any other stdin-driven agent CLI can be
added with a ten-line shell wrapper — see `core/agents/README.md`.

## How it fits together

```
preferences form ──► stack-preferences.json ─┐
                                             ▼
idea interview ───► plans/<slug>-build-plan.md ──► planner agent picks K
                                                   unblocked, disjoint slices
                                                        │
                        ┌───────────────────────────────┤
                        ▼                               ▼
                 worker 1..K (worktree:            fix lane (repairs
                 build agent → review agent        failing / conflicted /
                 → draft PR → mark ready)          stale-draft PRs)
                        │                               │
                        └────────────► serial merge lane ──► branch hygiene
```

Plans are the source of truth. The orchestrator's reconcile step keeps each
plan's slice statuses and status ledger in sync with what actually merged, so
the plan you read is the state of the project.

Read `docs/ARCHITECTURE.md` for the component contracts (config schema, event
stream, plan format, provider interface) and `planning/plan-format.md` for the
full plan spec.

## Safety model

- Everything runs locally; the UI binds to 127.0.0.1.
- Agents work in disposable git worktrees on `worker-*` branches — never on
  your checkouts' main branches.
- A draft PR is never force-readied: if the reviewing agent didn't finish, the
  fix lane finishes the review before anything merges.
- Every merge pass deletes the branches it made obsolete, locally and on the
  remote. Runs end with zero residue.

## Status

Early. The core pool is a hardened extraction of an orchestrator that has been
merging real PRs across an eight-repo codebase for weeks; the plan wizard, the
preferences form, and the UI are new. Expect sharp edges — file issues.

## License

MIT
