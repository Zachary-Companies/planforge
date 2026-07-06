# PlanForge build-plan format

<!-- KEEP IN SYNC: this file is the rendered mirror of the exported constant
PLAN_FORMAT_SPEC in planning/prompts.mjs. Edit both together;
planning/prompts.test.mjs fails if they drift. -->

A PlanForge build plan lives at `plans/<slug>-build-plan.md`. It is the single
source of truth for what gets built: the interview writes it, humans edit it,
reconcile passes refresh it, and the planner agent schedules work straight out
of it. This spec is injected verbatim into agent prompts, so every rule below
is binding for both people and agents.

## Document rules

1. Line 1 is exactly `# <Title> build plan`.
2. Line 2 is exactly `<!-- slug: <slug> -->` — kebab-case; the file is saved
   as `plans/<slug>-build-plan.md`.
3. The five sections appear in this order, with these exact headings:
   `## 1. Overview`, `## 2. Architecture`, `## 3. Open decisions`,
   `## 4. Phases`, `## 5. Status ledger`.
4. Prose is welcome anywhere, but the machine-read rows — decision rows, slice
   blocks, ledger rows — must match the formats below character-for-character.
5. Statuses are conservative commitments, not aspirations: when unsure, use
   the less-done status.

## `## 1. Overview`

Three labeled parts, each short:

- **Thesis** — one paragraph: what this is, for whom, and why it is worth
  building. No feature lists here.
- **Users** — who will actually use it (roles, not demographics).
- **Done when** — 3–6 checkable outcomes that define v1 complete. If it
  cannot be checked, it does not belong here.

A plan may open (above `## 1. Overview`) with a
`> **Status refresh (<YYYY-MM-DD>):** …` blockquote summarizing where the
build stands; the ledger (§5) remains authoritative.

## `## 2. Architecture`

- **Repo layout** — a short table or list mapping each top-level directory to
  what it owns.
- **Stack** — every technology choice must either follow the user's stack
  preferences or be recorded as a deviation in `## 3. Open decisions`
  (Accepted, with a one-line rationale). Never deviate silently. If no
  preferences were set, choose boring, mainstream defaults and record each
  notable choice as an Accepted decision.
- **Resources** — a list of every backing service the app needs to run,
  derived from its features. Read each feature and name what it requires:
  uploading or storing photos/audio/video/files needs OBJECT/FILE STORAGE
  (a blob store, not a database column); saved records need a DATABASE;
  sign-in needs AUTH; sessions/queues/rate-limits often need a CACHE;
  live updates need realtime/pub-sub. List each resource, why it is needed,
  and which provider provides it. Missing a resource here (e.g. storage for
  an upload feature) is a plan defect.
- **Contracts** — how the parts talk to each other (routes, file formats,
  schemas) in just enough detail that two slices touching either side agree.

## `## 3. Open decisions`

One decision per unresolved question, numbered D1..Dn. Decision row, exact:

```
- **D1 — <question>?** — Proposed|Accepted|Blocked: <answer, or options + recommendation>
```

- Ids are sequential and permanent: never reuse or renumber a D-id.
- **Proposed** — list the realistic options and exactly one recommendation.
  Do not silently pick one: a Proposed decision gates its slices.
- **Accepted** — the answer plus a one-line rationale (and a date, if known).
- **Blocked** — name the outside input needed (owner call, cost, credential).
- **Gating rule:** any slice that depends on a non-Accepted decision carries
  status `blocked-on-Dx` and is not buildable until Dx is Accepted.
- Anything the interview answers leave ambiguous becomes a decision with a
  recommendation — an honest open question beats an invented answer.
- Indented follow-up lines under a decision row (option detail, rationale)
  are encouraged.

## `## 4. Phases`

Phase headings, exact: `### Phase 1 — <name>`, `### Phase 2 — <name>`, …

Ordering rule: each phase ends with something runnable. Phase 1 is a walking
skeleton — it installs, starts, and does one real thing end-to-end. Later
phases keep the app runnable while deepening it. Never front-load
infrastructure the current phase does not need.

Each phase lists slices. Slice block, exact (`deps:` line optional):

```
- **<slice-id> — <title>**
  - paths: `path/a`, `path/b`
  - deps: <slice-id>, <slice-id>
  - status: pending
  - acceptance: <objective, checkable outcome>
```

- `slice-id` — kebab-case, unique across the whole plan.
- `paths` — repo-relative files or directories this slice creates or edits.
  This is the disjointness unit: two slices may build in parallel only if
  their paths do not overlap, so keep paths specific and honest. If two
  slices genuinely need the same file, give one a `deps:` on the other.
- `status` — exactly one of `pending | building | shipped | blocked-on-Dx`.
- `acceptance` — one or more lines; each is something a reviewer can verify
  without asking the author (a command that passes, a visible behavior, a
  file that exists with specific content). These are EXECUTED: `planforge eval`
  and a run's acceptance-eval phase hand each criterion to an independent
  evaluator agent that must prove it by running the feature (and adding a
  repeatable test for it), so write them as concrete, runnable checks — a slice
  is only truly done when every acceptance criterion is verified, not just when
  the build is green.
- Sizing: a slice is one PR that one worker can finish without waiting on
  anyone — roughly a day of focused work or less. If a slice needs two repos,
  two owners, or "and then also…", split it.

## Status vocabulary

| status | means |
|---|---|
| `pending` | not started; unblocked and buildable now |
| `building` | a worker is on it right now |
| `shipped` | merged to the default branch AND acceptance criteria verified |
| `blocked-on-Dx` | waits on decision Dx being Accepted |

- `shipped` is a verified claim, never a memory: confirm against the repo at
  a specific commit and record that commit in the ledger (§5).
- Prose may qualify a status (e.g. "shipped baseline — follow-ons remain"),
  but the machine-read `status:` line stays one of the four values.

## `## 5. Status ledger`

Append-only history of verification passes. Ledger row, exact:

```
- verified against <sha> <YYYY-MM-DD> — <what was checked; what changed>
```

- Newest row last. Never edit or delete an existing row.
- Every `status:` change in §4 must be justified by a ledger row.
- A brand-new plan (no code yet) writes:
  `- verified against none <YYYY-MM-DD> — plan created; all slices pending.`

## Minimal example

```markdown
# Recipe Box build plan
<!-- slug: recipe-box -->

## 1. Overview
**Thesis** — …  **Users** — …  **Done when** — …

## 2. Architecture
| Dir | Owns |
|---|---|
| `web/` | … |

## 3. Open decisions
- **D1 — Where are photos stored?** — Proposed: (a) local disk — boring,
  fine for one host; (b) S3-compatible bucket. Recommendation: (a) for v1.
  Gates `photo-upload`.

## 4. Phases
### Phase 1 — Walking skeleton
- **scaffold-app — App shell that boots**
  - paths: `package.json`, `web/index.html`, `web/src/main.tsx`
  - status: pending
  - acceptance: `npm install && npm run dev` serves a page titled "Recipe Box".
- **photo-upload — Attach a photo to a recipe**
  - paths: `web/src/components/PhotoUpload.tsx`, `server/src/routes/photos.ts`
  - deps: scaffold-app
  - status: blocked-on-D1
  - acceptance: an uploaded photo survives a server restart.

## 5. Status ledger
- verified against none 2026-07-02 — plan created; all slices pending.
```
