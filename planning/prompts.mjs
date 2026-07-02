/**
 * PlanForge planning prompts.
 *
 * Pure ESM, zero dependencies, no I/O: callers pass all content in. This
 * module owns the prompt text that turns interview answers + stack
 * preferences into build-plan documents, plus a tiny plan-summary parser
 * shared by the UI and CLI.
 *
 * Exports:
 *   PLAN_FORMAT_SPEC                                  — the plan format spec text
 *   renderPreferencesSummary(preferences)             — string
 *   buildInterviewPrompt({ answers, preferences })    — string
 *   buildRevisePrompt({ currentPlan, feedback, preferences }) — string
 *   parsePlanSummary(markdown)                        — { title, slug, phases, openDecisions, slices, accepted }
 */

/**
 * The authoritative build-plan format specification, embedded so prompt
 * building needs no file access.
 *
 * KEEP IN SYNC: planning/plan-format.md is the rendered mirror of this
 * constant. Edit both together; planning/prompts.test.mjs fails if they
 * drift.
 */
export const PLAN_FORMAT_SPEC = `# PlanForge build-plan format

<!-- KEEP IN SYNC: this file is the rendered mirror of the exported constant
PLAN_FORMAT_SPEC in planning/prompts.mjs. Edit both together;
planning/prompts.test.mjs fails if they drift. -->

A PlanForge build plan lives at \`plans/<slug>-build-plan.md\`. It is the single
source of truth for what gets built: the interview writes it, humans edit it,
reconcile passes refresh it, and the planner agent schedules work straight out
of it. This spec is injected verbatim into agent prompts, so every rule below
is binding for both people and agents.

## Document rules

1. Line 1 is exactly \`# <Title> build plan\`.
2. Line 2 is exactly \`<!-- slug: <slug> -->\` — kebab-case; the file is saved
   as \`plans/<slug>-build-plan.md\`.
3. The five sections appear in this order, with these exact headings:
   \`## 1. Overview\`, \`## 2. Architecture\`, \`## 3. Open decisions\`,
   \`## 4. Phases\`, \`## 5. Status ledger\`.
4. Prose is welcome anywhere, but the machine-read rows — decision rows, slice
   blocks, ledger rows — must match the formats below character-for-character.
5. Statuses are conservative commitments, not aspirations: when unsure, use
   the less-done status.

## \`## 1. Overview\`

Three labeled parts, each short:

- **Thesis** — one paragraph: what this is, for whom, and why it is worth
  building. No feature lists here.
- **Users** — who will actually use it (roles, not demographics).
- **Done when** — 3–6 checkable outcomes that define v1 complete. If it
  cannot be checked, it does not belong here.

A plan may open (above \`## 1. Overview\`) with a
\`> **Status refresh (<YYYY-MM-DD>):** …\` blockquote summarizing where the
build stands; the ledger (§5) remains authoritative.

## \`## 2. Architecture\`

- **Repo layout** — a short table or list mapping each top-level directory to
  what it owns.
- **Stack** — every technology choice must either follow the user's stack
  preferences or be recorded as a deviation in \`## 3. Open decisions\`
  (Accepted, with a one-line rationale). Never deviate silently. If no
  preferences were set, choose boring, mainstream defaults and record each
  notable choice as an Accepted decision.
- **Contracts** — how the parts talk to each other (routes, file formats,
  schemas) in just enough detail that two slices touching either side agree.

## \`## 3. Open decisions\`

One decision per unresolved question, numbered D1..Dn. Decision row, exact:

\`\`\`
- **D1 — <question>?** — Proposed|Accepted|Blocked: <answer, or options + recommendation>
\`\`\`

- Ids are sequential and permanent: never reuse or renumber a D-id.
- **Proposed** — list the realistic options and exactly one recommendation.
  Do not silently pick one: a Proposed decision gates its slices.
- **Accepted** — the answer plus a one-line rationale (and a date, if known).
- **Blocked** — name the outside input needed (owner call, cost, credential).
- **Gating rule:** any slice that depends on a non-Accepted decision carries
  status \`blocked-on-Dx\` and is not buildable until Dx is Accepted.
- Anything the interview answers leave ambiguous becomes a decision with a
  recommendation — an honest open question beats an invented answer.
- Indented follow-up lines under a decision row (option detail, rationale)
  are encouraged.

## \`## 4. Phases\`

Phase headings, exact: \`### Phase 1 — <name>\`, \`### Phase 2 — <name>\`, …

Ordering rule: each phase ends with something runnable. Phase 1 is a walking
skeleton — it installs, starts, and does one real thing end-to-end. Later
phases keep the app runnable while deepening it. Never front-load
infrastructure the current phase does not need.

Each phase lists slices. Slice block, exact (\`deps:\` line optional):

\`\`\`
- **<slice-id> — <title>**
  - paths: \`path/a\`, \`path/b\`
  - deps: <slice-id>, <slice-id>
  - status: pending
  - acceptance: <objective, checkable outcome>
\`\`\`

- \`slice-id\` — kebab-case, unique across the whole plan.
- \`paths\` — repo-relative files or directories this slice creates or edits.
  This is the disjointness unit: two slices may build in parallel only if
  their paths do not overlap, so keep paths specific and honest. If two
  slices genuinely need the same file, give one a \`deps:\` on the other.
- \`status\` — exactly one of \`pending | building | shipped | blocked-on-Dx\`.
- \`acceptance\` — one or more lines; each is something a reviewer can verify
  without asking the author (a command that passes, a visible behavior, a
  file that exists with specific content).
- Sizing: a slice is one PR that one worker can finish without waiting on
  anyone — roughly a day of focused work or less. If a slice needs two repos,
  two owners, or "and then also…", split it.

## Status vocabulary

| status | means |
|---|---|
| \`pending\` | not started; unblocked and buildable now |
| \`building\` | a worker is on it right now |
| \`shipped\` | merged to the default branch AND acceptance criteria verified |
| \`blocked-on-Dx\` | waits on decision Dx being Accepted |

- \`shipped\` is a verified claim, never a memory: confirm against the repo at
  a specific commit and record that commit in the ledger (§5).
- Prose may qualify a status (e.g. "shipped baseline — follow-ons remain"),
  but the machine-read \`status:\` line stays one of the four values.

## \`## 5. Status ledger\`

Append-only history of verification passes. Ledger row, exact:

\`\`\`
- verified against <sha> <YYYY-MM-DD> — <what was checked; what changed>
\`\`\`

- Newest row last. Never edit or delete an existing row.
- Every \`status:\` change in §4 must be justified by a ledger row.
- A brand-new plan (no code yet) writes:
  \`- verified against none <YYYY-MM-DD> — plan created; all slices pending.\`

## Minimal example

\`\`\`markdown
# Recipe Box build plan
<!-- slug: recipe-box -->

## 1. Overview
**Thesis** — …  **Users** — …  **Done when** — …

## 2. Architecture
| Dir | Owns |
|---|---|
| \`web/\` | … |

## 3. Open decisions
- **D1 — Where are photos stored?** — Proposed: (a) local disk — boring,
  fine for one host; (b) S3-compatible bucket. Recommendation: (a) for v1.
  Gates \`photo-upload\`.

## 4. Phases
### Phase 1 — Walking skeleton
- **scaffold-app — App shell that boots**
  - paths: \`package.json\`, \`web/index.html\`, \`web/src/main.tsx\`
  - status: pending
  - acceptance: \`npm install && npm run dev\` serves a page titled "Recipe Box".
- **photo-upload — Attach a photo to a recipe**
  - paths: \`web/src/components/PhotoUpload.tsx\`, \`server/src/routes/photos.ts\`
  - deps: scaffold-app
  - status: blocked-on-D1
  - acceptance: an uploaded photo survives a server restart.

## 5. Status ledger
- verified against none 2026-07-02 — plan created; all slices pending.
\`\`\`
`;

const NO_PREFERENCES_SUMMARY =
  "No stack preferences were set. Choose boring, mainstream, well-documented " +
  "technology with strong defaults, and record every notable stack choice as " +
  "an Accepted open decision (D-item) with a one-line rationale, so the user " +
  "can see — and veto — what was picked for them.";

const GROUP_LABELS = {
  general: "General",
  webApp: "Web app",
  mobileApp: "Mobile app",
  api: "API / backend",
  cli: "CLI",
  data: "Data / analytics",
};

function formatValue(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).filter((v) => v.trim() !== "").join(", ");
  }
  return String(value);
}

/**
 * Compact, human-readable summary of a stack-preferences object
 * (see planning/preferences-schema.json). null/undefined/empty input yields
 * a sentence telling the agent to pick boring defaults and record them as
 * decisions.
 *
 * @param {object|null|undefined} preferences
 * @returns {string}
 */
export function renderPreferencesSummary(preferences) {
  if (preferences == null || typeof preferences !== "object") {
    return NO_PREFERENCES_SUMMARY;
  }
  const lines = [];
  for (const [group, label] of Object.entries(GROUP_LABELS)) {
    const fields = preferences[group];
    if (fields == null || typeof fields !== "object") continue;
    const parts = Object.entries(fields)
      .filter(([, v]) => v != null && formatValue(v).trim() !== "")
      .map(([k, v]) => `${k}: ${formatValue(v)}`);
    if (parts.length > 0) lines.push(`- ${label}: ${parts.join("; ")}`);
  }
  if (typeof preferences.freeform === "string" && preferences.freeform.trim() !== "") {
    lines.push(`- Freeform notes: ${preferences.freeform.trim()}`);
  }
  if (lines.length === 0) return NO_PREFERENCES_SUMMARY;
  return [
    "Stack preferences (set by the user — follow them; any deviation must be " +
      "recorded as an Accepted decision with a rationale, never made silently):",
    ...lines,
  ].join("\n");
}

/**
 * Accepts either an array of { label, response|answer|value } items or a
 * plain object of label → response, and normalizes to [{ label, response }].
 */
function normalizeAnswers(answers) {
  if (Array.isArray(answers)) {
    return answers
      .filter((item) => item != null && typeof item === "object")
      .map((item) => ({
        label: String(item.label ?? item.question ?? item.id ?? "Question"),
        response: formatValue(item.response ?? item.answer ?? item.value ?? ""),
      }));
  }
  if (answers != null && typeof answers === "object") {
    return Object.entries(answers).map(([label, value]) => ({
      label,
      response: formatValue(value ?? ""),
    }));
  }
  return [];
}

function renderAnswers(answers) {
  const rows = normalizeAnswers(answers);
  if (rows.length === 0) {
    return (
      "(No interview answers were provided. Treat everything as undecided: " +
      "keep the plan minimal and push every real question into Open Decisions.)"
    );
  }
  return rows
    .map(({ label, response }) =>
      `- ${label}: ${response.trim() === "" ? "(not answered)" : response}`,
    )
    .join("\n");
}

/**
 * Prompt instructing an agent to produce ONE complete build-plan markdown
 * document from interview answers + stack preferences.
 *
 * @param {{ answers?: Array<object>|object, preferences?: object|null }} input
 * @returns {string}
 */
export function buildInterviewPrompt({ answers, preferences } = {}) {
  return [
    "You are a senior software planner. From the interview answers below, " +
      "produce ONE complete build plan document in markdown. The plan will be " +
      "executed by autonomous build agents working in parallel, one slice per " +
      "pull request, so precision and honesty matter more than optimism.",
    "",
    "## Interview answers",
    "",
    renderAnswers(answers),
    "",
    "## Stack preferences",
    "",
    renderPreferencesSummary(preferences),
    "",
    "## Plan format (binding specification)",
    "",
    PLAN_FORMAT_SPEC.trim(),
    "",
    "## Requirements",
    "",
    "1. Honest open decisions. Anything the answers leave ambiguous or silent " +
      "becomes a numbered D-item in `## 3. Open decisions` with realistic " +
      "options and exactly one recommendation — do NOT invent an answer and " +
      "move on. Slices that depend on an unresolved decision carry status " +
      "`blocked-on-Dx`.",
    "2. Small, file-disjoint slices. A slice is one PR that one worker can " +
      "finish without waiting on anyone (roughly a day of focused work or " +
      "less). Give every slice honest, specific `paths:`; slices that could " +
      "build in parallel must not share paths — where they must, use `deps:`.",
    "3. Runnable phases. Order phases so each one ends with something a " +
      "person can run and see. Phase 1 is a walking skeleton: it installs, " +
      "starts, and does one real thing end-to-end.",
    "4. Acceptance criteria per slice. Every slice has at least one " +
      "objective, checkable acceptance line a reviewer can verify without " +
      "asking the author.",
    "5. Stack follows preferences. Choose the stack from the preferences " +
      "summary above; record any deviation as an Accepted decision with a " +
      "rationale. If no preferences were set, choose boring, mainstream " +
      "defaults and record each notable choice as an Accepted decision.",
    "6. Fresh-plan statuses. Every slice starts `pending` (or " +
      "`blocked-on-Dx`); the status ledger contains exactly one creation row " +
      "(`- verified against none <date> — plan created; all slices pending.`).",
    "",
    "## Output",
    "",
    "Output ONLY the plan document as raw markdown — no preamble, no " +
      "commentary after it, no surrounding code fence. The first line must be " +
      "exactly `# <Title> build plan`, and the second line must be the slug " +
      "comment `<!-- slug: <kebab-case-slug> -->`.",
  ].join("\n");
}

/**
 * Prompt instructing an agent to revise an existing build plan per user
 * feedback, preserving history (ledger rows, shipped statuses).
 *
 * @param {{ currentPlan?: string, feedback?: string, preferences?: object|null }} input
 * @returns {string}
 */
export function buildRevisePrompt({ currentPlan, feedback, preferences } = {}) {
  return [
    "You are a senior software planner revising an existing build plan based " +
      "on user feedback. The plan is executed by autonomous build agents, so " +
      "keep it precise and keep its history intact.",
    "",
    "## Current plan",
    "",
    String(currentPlan ?? "").trim() || "(no current plan was provided)",
    "",
    "## User feedback",
    "",
    String(feedback ?? "").trim() || "(no feedback was provided — return the plan unchanged)",
    "",
    "## Stack preferences",
    "",
    renderPreferencesSummary(preferences),
    "",
    "## Plan format (binding specification)",
    "",
    PLAN_FORMAT_SPEC.trim(),
    "",
    "## Revision rules",
    "",
    "1. Apply the feedback faithfully; where it is ambiguous, add or update " +
      "an open decision with a recommendation instead of guessing.",
    "2. Preserve history. The status ledger is append-only: keep every " +
      "existing ledger row untouched and in order, and append one new row " +
      "describing this revision. Never rewrite or delete history.",
    "3. Never demote shipped. Slices with status `shipped` keep that status " +
      "and their acceptance text. If feedback invalidates shipped work, add " +
      "a new slice that changes it rather than editing the old one.",
    "4. Keep ids stable. Decision ids (D1..Dn) and slice ids never change " +
      "meaning or get reused; add new ones at the end. Removing a not-yet-" +
      "built slice is allowed; renumbering is not.",
    "5. Stack changes requested by the feedback are recorded as decisions, " +
      "per the preferences rules above.",
    "",
    "## Output",
    "",
    "Output ONLY the full revised plan document as raw markdown — no " +
      "preamble, no commentary, no surrounding code fence. Keep the same " +
      "first-line title format (`# <Title> build plan`) and the same slug " +
      "comment unless the feedback explicitly renames the project.",
  ].join("\n");
}

/**
 * Tiny regex-based parser over a plan document, shared by the UI and CLI.
 * Returns counts only — the plan document itself stays the source of truth.
 *
 * @param {string} markdown
 * @returns {{ title: string|null, slug: string|null, phases: number, openDecisions: number, slices: number, accepted: number }}
 */
// The exact reply a consistency-review agent gives when it finds nothing to fix.
// Callers compare the agent's trimmed output against this to end the review loop.
export const PLAN_CONSISTENT_MARKER = "PLAN-CONSISTENT";

export function buildDeepenPrompt({ currentPlan, preferences } = {}) {
  return [
    "You are a senior software planner doing the DETAIL pass on a draft " +
      "build plan. The plan will be executed by autonomous build agents that " +
      "each pick up ONE slice with no other context, so every slice must be " +
      "implementation-ready on its own.",
    "",
    "## Current plan (draft)",
    "",
    String(currentPlan ?? "").trim() || "(no plan was provided)",
    "",
    "## Stack preferences",
    "",
    renderPreferencesSummary(preferences),
    "",
    "## Plan format (binding specification)",
    "",
    PLAN_FORMAT_SPEC.trim(),
    "",
    "## Deepening rules",
    "",
    "1. Architecture first: expand `## 2. Architecture` until an agent could " +
      "start coding from it — the repo layout as a real directory tree, the " +
      "data model (entities, fields, relations), API routes or module " +
      "interfaces with method signatures, and how the pieces talk to each " +
      "other. Name real files.",
    "2. Every slice becomes buildable in one PR: concrete repo-relative " +
      "`paths` (source AND test files), acceptance criteria an agent can " +
      "verify mechanically (a command to run, a behavior to demonstrate — " +
      "not \"works well\"), and any contracts the slice must honor (types, " +
      "routes, schemas named in §2).",
    "3. Split anything too big. A slice an agent cannot finish in one PR " +
      "gets split into smaller slices in the same phase (new ids at the " +
      "end; never reuse ids). Phase order must still leave something " +
      "runnable after every phase.",
    "4. Do NOT invent requirements. Where detail requires a choice the user " +
      "never made, add an open decision (D-item) with options and a " +
      "recommendation, and gate the affected slices with `blocked-on-Dx`. " +
      "Depth means precision about the KNOWN, not fiction about the unknown.",
    "5. Preserve history: the title, slug, decision ids, existing slice ids, " +
      "shipped statuses, and every ledger row stay intact.",
    "",
    "## Output",
    "",
    "Output ONLY the full deepened plan document as raw markdown — no " +
      "preamble, no commentary, no surrounding code fence.",
  ].join("\n");
}

export function buildConsistencyReviewPrompt({ currentPlan, preferences, passNumber } = {}) {
  const pass = Number.isInteger(passNumber) && passNumber > 0 ? passNumber : 1;
  return [
    "You are a meticulous plan reviewer doing consistency pass " +
      `${pass} on a build plan. Your ONLY job is to find and fix ` +
      "inconsistencies — you do not add scope, restyle prose, or second-" +
      "guess decisions the user accepted.",
    "",
    "## Plan under review",
    "",
    String(currentPlan ?? "").trim() || "(no plan was provided)",
    "",
    "## Stack preferences",
    "",
    renderPreferencesSummary(preferences),
    "",
    "## Plan format (binding specification)",
    "",
    PLAN_FORMAT_SPEC.trim(),
    "",
    "## Consistency checklist (check every item)",
    "",
    "1. Decision gates: every `blocked-on-Dx` references a D-item that " +
      "exists and is NOT Accepted; conversely, any slice that depends on a " +
      "non-Accepted decision is actually gated. An Accepted decision leaves " +
      "no slice still blocked on it.",
    "2. Ids: slice ids and decision ids are unique; kebab-case slice ids; " +
      "no gaps in D-numbering; nothing references an id that does not exist.",
    "3. Paths: repo-relative, consistent with the directory tree in §2 " +
      "(no path under a directory §2 does not define), test files included " +
      "where acceptance criteria imply tests.",
    "4. Statuses: only the format's vocabulary; a draft plan ships nothing, " +
      "so `shipped` may only appear if the ledger has a row justifying it.",
    "5. Phases: numbered contiguously; each phase's outcome line says what " +
      "is runnable when it completes; no slice depends on work scheduled in " +
      "a LATER phase.",
    "6. Cross-section agreement: the stack named in §1/§2 matches what the " +
      "slices actually build; features promised in §1 map to at least one " +
      "slice; every §3 recommendation is consistent with §2's architecture; " +
      "nothing in the plan contradicts the stack preferences without a " +
      "decision recording the deviation.",
    "7. Acceptance criteria: present on every slice, mechanically checkable, " +
      "and consistent with the slice's paths.",
    "8. Ledger: well-formed rows, chronological, append-only shape.",
    "",
    "## Output — exactly one of two forms",
    "",
    `1. If EVERY checklist item passes, reply with exactly \`${PLAN_CONSISTENT_MARKER}\` ` +
      "and nothing else.",
    "2. Otherwise output ONLY the full corrected plan document as raw " +
      "markdown (no preamble, no list of findings, no code fence), with " +
      "every inconsistency fixed and history preserved (title, slug, ids, " +
      "shipped statuses, ledger rows).",
  ].join("\n");
}

export function parsePlanSummary(markdown) {
  const text = typeof markdown === "string" ? markdown : "";
  const count = (re) => (text.match(re) ?? []).length;

  const titleMatch = text.match(/^#\s+(.+?)\s*$/m);
  const rawTitle = titleMatch ? titleMatch[1].trim() : null;
  const title = rawTitle ? rawTitle.replace(/\s+build plan$/i, "").trim() : null;

  const slugMatch = text.match(/<!--\s*slug:\s*([a-z0-9][a-z0-9-]*)\s*-->/i);
  const slug = slugMatch ? slugMatch[1].toLowerCase() : null;

  const phases = count(/^###\s+Phase\s+\d+\s*[—–-]/gim);
  const openDecisions = count(/^-\s+\*\*D\d+\s*[—–-]/gim);
  const accepted = count(/^-\s+\*\*D\d+\s*[—–-][^\n]*?\*\*\s*[—–-]+\s*Accepted\b/gim);
  const slices = count(/^\s*-\s+status:\s*(?:pending|building|shipped|blocked-on-D\d+)\b/gim);

  return { title, slug, phases, openDecisions, slices, accepted };
}
