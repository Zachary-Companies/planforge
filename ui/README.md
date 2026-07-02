# PlanForge UI

A zero-dependency local web UI for PlanForge: a preferences form, a guided
plan wizard, and a live multi-agent run dashboard. One `node:http` server
(`server.mjs`) serves the single-page app in `app/` plus a JSON API over your
PlanForge workspace. No build step, no npm dependencies, works offline.

```sh
node ui/server.mjs            # http://127.0.0.1:4173
PLANFORGE_PORT=5000 node ui/server.mjs
PLANFORGE_CONFIG=~/code/myws/planforge.config.json node ui/server.mjs
```

The server binds **127.0.0.1 only** and has no auth — it is a local tool.
The workspace is the directory containing `planforge.config.json`, found via
`PLANFORGE_CONFIG` or by walking up from the current directory. Without a
config file the server still runs against the current directory with defaults,
so the UI works standalone.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/config` | Loaded config (workspace, repos, plansDir, workers, …) plus `hasPreferences`, `hasPlansDir`, `hasCli`, `configPath`. |
| GET | `/api/questions` | `planning/questions.json` **verbatim** — the single source of truth for both the preferences form (`preferences.groups`) and the plan wizard (`interview.steps`). If the file is missing or unparseable, a built-in minimal set is served with `"fallback": true`. |
| GET | `/api/preferences` | Parsed `stack-preferences.json`; `404` if not written yet. |
| POST | `/api/preferences` | Minimal shape check against `planning/preferences-schema.json` (object; known top-level keys type-checked; unknown keys preserved), then writes `stack-preferences.json` **and** a readable `TECH-PREFERENCES.md` next to it. |
| GET | `/api/plans` | `[{ slug, title, path, phases, openDecisions, mtime }]` parsed from `<workspace>/<plansDir>/*-build-plan.md` (cheap regex over `##`/`###` headings; a decision counts as open unless its block says `Accepted`). |
| GET | `/api/plans/:slug` | Raw plan markdown (`text/markdown`). |
| POST | `/api/plans` | Body `{ answers: {…} }`. Writes the answers to a tmp file under `<workspace>/.planforge/tmp/` and spawns `node bin/planforge.mjs plan --answers <tmpfile>`. Responds with a **chunked NDJSON progress stream** (see below). |
| POST | `/api/plans/:slug/revise` | Body `{ feedback: "…" }`. Same mechanism with `plan --revise <slug> --feedback <tmpfile>`. If the CLI rejects those flags, the stream ends with a clear `error` line. |
| GET | `/api/runs` | Run dirs under `<workspace>/.planforge/runs/`, newest first: `{ id, status, events, runStart, stats, runDone, pid, pidAlive, startedAt }` — `stats` is the *last* stats event, `runDone` present when the run finished. |
| POST | `/api/runs` | Body `{ workers?, maxSlices?, seedSlices? }`. Spawns `node bin/planforge.mjs run [--config …] [--workers N] [--max-slices N] [--seed-slices <file>]` **detached**, waits for the orchestrator to create its run dir under `.planforge/runs/`, then adopts it (stdout/stderr → `orchestrator.log`, pid → `pids.json`) and returns `{ ok, id, pid }` where `id` is the run dir name. |
| GET | `/api/runs/:id/events` | **Server-Sent Events** — see the SSE contract below. |
| POST | `/api/runs/:id/stop` | SIGTERMs the recorded pid (process group first), records `stoppedAt` in `pids.json`. `409` if no live pid is tracked. |

Anything else is served from `app/` (path-traversal rejected).

## The SSE contract

The orchestrator appends one JSON object per line to
`<runDir>/events.ndjson` (shapes are exactly `docs/ARCHITECTURE.md` §2 —
stable, additive-only). `GET /api/runs/:id/events`:

1. **Replays** `events.ndjson` from byte 0 — one SSE `data:` frame per NDJSON
   line, verbatim, in order. A reconnecting or late-joining client rebuilds
   the full run state from the stream alone (the page is event-sourced).
2. **Tails** the file: new complete lines are pushed as they are appended,
   via `fs.watch` on the run dir with a 500 ms polling fallback. Partial
   trailing lines are buffered until the newline arrives.
3. If the file shrinks (rotation/truncation) the stream replays from byte 0
   again. Comment frames (`: ping`) are sent every 15 s as keep-alives;
   `retry: 2000` asks clients to reconnect after 2 s on drops.

The server never interprets events — it is a byte-faithful relay, so new
event types flow through to the UI without a server change.

## NDJSON progress stream (plan / revise)

`POST /api/plans` and `POST /api/plans/:slug/revise` respond
`application/x-ndjson`, one JSON object per line while the child runs:

```
{ "type": "start",    "cmd": "node bin/planforge.mjs plan --answers …" }
{ "type": "progress", "line": "…one stdout line…" }
{ "type": "progress", "stream": "stderr", "line": "…" }
{ "type": "done",     "ok": true, "code": 0, "slug": "my-app" }        ← success
{ "type": "error",    "ok": false, "code": 1, "message": "…" }         ← failure
```

The new plan's slug is detected by diffing `<plansDir>/*-build-plan.md`
before/after (a CLI may also print `@plan-slug <slug>` on stdout to name it
explicitly). For revise, the slug is already known.

## Environment variables / test seams

| Var | Effect |
|---|---|
| `PLANFORGE_PORT` | Listen port (default `4173`). |
| `PLANFORGE_CONFIG` | Path to `planforge.config.json` (or its directory). Otherwise: walk-up discovery from cwd. |
| `PLANFORGE_QUESTIONS` | Alternate path for `questions.json` (default `planning/questions.json`). |
| `PLANFORGE_PLAN_CMD` | **Test seam** — spawned instead of `node bin/planforge.mjs` for plan/revise. Split shell-style (quotes honored); the standard args (`plan --answers …`) are appended. |
| `PLANFORGE_RUN_CMD` | **Test seam** — same, for `POST /api/runs`. The command is expected to behave like the real CLI: create its own run dir under `<workspace>/.planforge/runs/` and append `events.ndjson` there. |

## Tests

```sh
node --test ui/                    # Node 20/22
node --test 'ui/**/*.test.mjs'     # newer Node versions that dropped bare-directory args
```

`ui/server.test.mjs` starts the server on an ephemeral port against a fixture
workspace in a tmp dir and covers config, questions fallback + verbatim
serving, plan parsing, the preferences round-trip (including
`TECH-PREFERENCES.md`), the SSE replay of canned events, and both spawn seams.
No real agents are spawned.
