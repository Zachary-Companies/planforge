# <Title> build plan
<!-- slug: <kebab-case-slug> -->
<!-- TEMPLATE — replace every <angle-bracket> placeholder and delete these
     guidance comments before saving. The binding rules live in
     planning/plan-format.md; this template just paces you through them.
     Save the finished plan as plans/<slug>-build-plan.md. -->

<!-- Optional: a status-refresh blockquote goes here once the build is moving.
> **Status refresh (<YYYY-MM-DD>):** <one paragraph: what shipped, what is
> next, what is blocked. The ledger in §5 stays authoritative.>
-->

## 1. Overview

**Thesis** — <One paragraph: what this is, for whom, and why it is worth
building. Resist listing features here — that is what phases are for.>

**Users** — <Who actually uses it. Roles, not demographics: "me and my
climbing group", "the shop owner and their two employees".>

**Done when** —
- <3–6 checkable outcomes. Good: "two people on different phones see the same
  list within 10 seconds." Bad: "the app feels fast.">
- <…>

## 2. Architecture

<!-- Keep this section short. A table for layout, a paragraph for stack, a
     few lines for contracts. Detail lives in the slices. -->

Repo layout:

| Dir | Owns |
|---|---|
| `<dir>/` | <what lives here and why it is separate> |

**Stack** (from `stack-preferences.json`): <name each major choice and the
preference it follows, e.g. "React + Vite per webApp.framework/webApp.meta".
Any deviation from preferences MUST point at an Accepted decision in §3 —
never deviate silently. No preferences set? Choose boring, mainstream
defaults and record each notable choice as an Accepted decision.>

Contracts:
- <How the parts talk: route shapes, file formats, ports, schemas — just
  enough that two slices touching either side agree.>

## 3. Open decisions

<!-- One decision per genuinely unresolved question, numbered D1..Dn, never
     renumbered. Every ambiguity from the interview belongs here with a
     recommendation — an honest open question beats an invented answer.
     Row format is exact; slices gated on a non-Accepted decision carry
     status blocked-on-Dx. -->

- **D1 — <question>?** — Accepted: <answer + one-line rationale (+ date)>
- **D2 — <question>?** — Proposed: (a) <option — trade-off>; (b) <option —
  trade-off>. Recommendation: <exactly one of them, and why>. Gates
  `<slice-id>`.

## 4. Phases

<!-- Order phases so each ends with something runnable. Phase 1 is the
     walking skeleton: installs, starts, does one real thing end-to-end.
     A slice = one PR one worker can finish (~a day or less). paths are the
     parallelism unit — keep them specific, and disjoint between slices that
     could run at the same time (use deps: when they can't be). -->

### Phase 1 — <name, e.g. "Walking skeleton">

- **<slice-id> — <title>**
  - paths: `<path/a>`, `<path/b>`
  - status: pending
  - acceptance: <something a reviewer can verify without asking you: a
    command that passes, a behavior they can see, a file with specific
    content>

- **<slice-id> — <title>**
  - paths: `<path/c>`
  - deps: <slice-id>
  - status: pending
  - acceptance: <…>

### Phase 2 — <name>

- **<slice-id> — <title>**
  - paths: `<…>`
  - status: blocked-on-D2
  - acceptance: <…>

### Phase 3 — <name>

- **<slice-id> — <title>**
  - paths: `<…>`
  - status: pending
  - acceptance: <…>

## 5. Status ledger

<!-- Append-only. One row per verification pass, newest last; never edit or
     delete old rows. Every status change in §4 must be justified by a row
     here. Use sha "none" only for a brand-new plan with no code yet. -->

- verified against none <YYYY-MM-DD> — plan created; all slices pending.
