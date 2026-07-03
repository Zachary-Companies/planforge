import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLAN_FORMAT_SPEC,
  renderPreferencesSummary,
  buildInterviewPrompt,
  buildRevisePrompt,
  parsePlanSummary,
} from "./prompts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(path.join(here, ...parts), "utf8");

const examplePreferences = JSON.parse(read("..", "examples", "stack-preferences.example.json"));
const examplePlan = read("..", "examples", "todo-with-friends-build-plan.md");
const preferencesSchema = JSON.parse(read("preferences-schema.json"));
const questions = JSON.parse(read("questions.json"));

// ---------------------------------------------------------------------------
// PLAN_FORMAT_SPEC ↔ plan-format.md mirror
// ---------------------------------------------------------------------------

test("PLAN_FORMAT_SPEC is an exact mirror of plan-format.md", () => {
  assert.equal(PLAN_FORMAT_SPEC, read("plan-format.md"));
});

// ---------------------------------------------------------------------------
// renderPreferencesSummary
// ---------------------------------------------------------------------------

test("renderPreferencesSummary: null/undefined/empty → boring-defaults sentence", () => {
  for (const input of [null, undefined, {}, { version: 1 }]) {
    const out = renderPreferencesSummary(input);
    assert.match(out, /No stack preferences were set/);
    assert.match(out, /boring, mainstream/);
    assert.match(out, /decision/i);
  }
});

test("renderPreferencesSummary: full example preferences render every set group", () => {
  const out = renderPreferencesSummary(examplePreferences);
  assert.match(out, /Stack preferences/);
  assert.match(out, /General: .*languages: typescript/);
  assert.match(out, /Web app: .*framework: react/);
  assert.match(out, /meta: vite/);
  assert.match(out, /API \/ backend: .*framework: express/);
  assert.match(out, /CLI: .*argParsing: commander/);
  assert.match(out, /Freeform notes: Prefer boring/);
  // groups not present in the example stay out of the summary
  assert.doesNotMatch(out, /Mobile app:/);
  assert.doesNotMatch(out, /Data \/ analytics:/);
});

test("renderPreferencesSummary: partial preferences render arrays and skip empties", () => {
  const out = renderPreferencesSummary({
    version: 1,
    general: { languages: ["go", "python"], packageManager: "" },
    webApp: {},
  });
  assert.match(out, /General: languages: go, python/);
  assert.doesNotMatch(out, /packageManager/);
  assert.doesNotMatch(out, /Web app:/);
});

// ---------------------------------------------------------------------------
// buildInterviewPrompt
// ---------------------------------------------------------------------------

test("buildInterviewPrompt: injects answers, preferences, spec, and key directives", () => {
  const prompt = buildInterviewPrompt({
    answers: [
      { id: "idea", label: "What are you building?", response: "A recipe box for my family" },
      { id: "users", label: "Who will use it?", response: "" },
      { id: "app-kinds", label: "What kind of app is it?", response: ["Web app", "API / backend service"] },
    ],
    preferences: examplePreferences,
  });

  // answers as label + response pairs
  assert.match(prompt, /- What are you building\?: A recipe box for my family/);
  assert.match(prompt, /- Who will use it\?: \(not answered\)/);
  assert.match(prompt, /- What kind of app is it\?: Web app, API \/ backend service/);
  // preferences summary
  assert.match(prompt, /framework: react/);
  // the full format spec is embedded
  assert.ok(prompt.includes(PLAN_FORMAT_SPEC.trim()));
  assert.match(prompt, /## Document rules/);
  // key directives
  assert.match(prompt, /do NOT invent an answer/);
  assert.match(prompt, /blocked-on-Dx/);
  assert.match(prompt, /must not share paths/);
  assert.match(prompt, /walking skeleton/i);
  assert.match(prompt, /acceptance/i);
  assert.match(prompt, /deviation as an Accepted decision|deviation is recorded|record any deviation/i);
  // output contract
  assert.match(prompt, /Output ONLY the plan document/);
  assert.match(prompt, /# <Title> build plan/);
  assert.match(prompt, /<!-- slug: <kebab-case-slug> -->/);
});

test("buildInterviewPrompt: accepts plain-object answers and missing input", () => {
  const prompt = buildInterviewPrompt({ answers: { Scale: "Just me" } });
  assert.match(prompt, /- Scale: Just me/);
  assert.match(prompt, /No stack preferences were set/);

  const bare = buildInterviewPrompt();
  assert.match(bare, /No interview answers were provided/);
  assert.ok(bare.includes(PLAN_FORMAT_SPEC.trim()));
});

// ---------------------------------------------------------------------------
// buildRevisePrompt
// ---------------------------------------------------------------------------

test("buildRevisePrompt: injects plan, feedback, spec, and history-preserving rules", () => {
  const prompt = buildRevisePrompt({
    currentPlan: examplePlan,
    feedback: "Drop the mobile polish and add CSV export of a list.",
    preferences: examplePreferences,
  });

  assert.ok(prompt.includes("# Todo with Friends build plan"));
  assert.match(prompt, /Drop the mobile polish and add CSV export/);
  assert.ok(prompt.includes(PLAN_FORMAT_SPEC.trim()));
  // ledger + shipped preservation
  assert.match(prompt, /append-only/);
  assert.match(prompt, /append one new row/);
  assert.match(prompt, /Never rewrite or delete history/);
  assert.match(prompt, /Never demote shipped/);
  // output contract
  assert.match(prompt, /Output ONLY the full revised plan document/);
});

// ---------------------------------------------------------------------------
// parsePlanSummary
// ---------------------------------------------------------------------------

test("parsePlanSummary: example plan fixture", () => {
  assert.deepEqual(parsePlanSummary(examplePlan), {
    title: "Todo with Friends",
    slug: "todo-with-friends",
    phases: 3,
    openDecisions: 2,
    slices: 10,
    accepted: 1,
  });
});

test("parsePlanSummary: inline fixture and degenerate input", () => {
  const mini = [
    "# Tiny Tool build plan",
    "<!-- slug: tiny-tool -->",
    "## 3. Open decisions",
    "- **D1 — Which registry?** — Accepted: npm; it is where the users are.",
    "- **D2 — Config file format?** — Proposed: (a) JSON; (b) TOML. Recommendation: (a).",
    "- **D3 — Sign releases?** — Blocked: needs an owner decision on key custody.",
    "## 4. Phases",
    "### Phase 1 — Walking skeleton",
    "- **scaffold-cli — CLI that prints help**",
    "  - paths: `package.json`, `src/cli.mjs`",
    "  - status: shipped",
    "  - acceptance: `npx tiny-tool --help` prints usage.",
    "- **config-load — Load config**",
    "  - paths: `src/config.mjs`",
    "  - status: blocked-on-D2",
    "  - acceptance: bad config exits non-zero with a readable error.",
    "## 5. Status ledger",
    "- verified against abc1234 2026-07-02 — scaffold-cli shipped.",
  ].join("\n");

  assert.deepEqual(parsePlanSummary(mini), {
    title: "Tiny Tool",
    slug: "tiny-tool",
    phases: 1,
    openDecisions: 3,
    slices: 2,
    accepted: 1,
  });

  assert.deepEqual(parsePlanSummary(""), {
    title: null,
    slug: null,
    phases: 0,
    openDecisions: 0,
    slices: 0,
    accepted: 0,
  });
  assert.equal(parsePlanSummary(undefined).slices, 0);
});

// ---------------------------------------------------------------------------
// preferences-schema.json — tiny inline draft-07 subset validator
// (supports exactly the keywords the schema uses: type, required, properties,
// additionalProperties, items, minimum)
// ---------------------------------------------------------------------------

function jsonType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function validate(schema, value, at = "$", errors = []) {
  if (schema.type) {
    const t = jsonType(value);
    const ok = schema.type === t || (schema.type === "number" && t === "integer");
    if (!ok) {
      errors.push(`${at}: expected ${schema.type}, got ${t}`);
      return errors;
    }
  }
  if (jsonType(value) === "object") {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}: missing required "${key}"`);
    }
    for (const [key, v] of Object.entries(value)) {
      const prop = schema.properties?.[key];
      if (prop) validate(prop, v, `${at}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property "${key}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validate(schema.additionalProperties, v, `${at}.${key}`, errors);
      }
    }
  }
  if (jsonType(value) === "array" && schema.items) {
    value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, errors));
  }
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    errors.push(`${at}: ${value} is below minimum ${schema.minimum}`);
  }
  return errors;
}

test("examples/stack-preferences.example.json validates against preferences-schema.json", () => {
  assert.deepEqual(validate(preferencesSchema, examplePreferences), []);
});

test("preferences schema rejects malformed documents", () => {
  assert.ok(validate(preferencesSchema, {}).some((e) => e.includes('missing required "version"')));
  assert.ok(validate(preferencesSchema, { version: "1" }).length > 0);
  assert.ok(
    validate(preferencesSchema, { version: 1, webapp: {} }).some((e) => e.includes("unexpected property")),
    "typo'd group name must be rejected at the root",
  );
  assert.ok(validate(preferencesSchema, { version: 1, general: { languages: "typescript" } }).length > 0);
  assert.ok(validate(preferencesSchema, { version: 0 }).some((e) => e.includes("minimum")));
});

// ---------------------------------------------------------------------------
// questions.json — the single source both UI forms render
// ---------------------------------------------------------------------------

test("questions.json: preference questions map onto the schema and stay approachable", () => {
  assert.equal(questions.version, 1);
  assert.ok(Array.isArray(questions.preferences) && questions.preferences.length >= 30);

  const groups = ["general", "webApp", "mobileApp", "api", "cli", "data"];
  const ids = new Set();
  for (const q of questions.preferences) {
    for (const key of ["id", "group", "label", "help", "type", "mapsTo"]) {
      assert.ok(typeof q[key] === "string" && q[key].length > 0, `${q.id ?? "?"}: missing ${key}`);
    }
    assert.ok(!ids.has(q.id), `duplicate question id ${q.id}`);
    ids.add(q.id);
    assert.ok(groups.includes(q.group), `${q.id}: unknown group ${q.group}`);
    assert.ok(["select", "multiselect", "text"].includes(q.type), `${q.id}: bad type ${q.type}`);

    // mapsTo = "<group>.<field>" and the field is declared in the schema
    const [mapGroup, mapField] = q.mapsTo.split(".");
    assert.equal(mapGroup, q.group, `${q.id}: mapsTo group mismatch`);
    const groupSchema = preferencesSchema.properties[mapGroup];
    assert.ok(groupSchema?.properties?.[mapField], `${q.id}: ${q.mapsTo} not in schema`);

    // multiselects land on array fields; selects on strings
    const fieldSchema = groupSchema.properties[mapField];
    if (q.type === "multiselect") assert.equal(fieldSchema.type, "array", `${q.id}: multiselect needs array field`);
    if (q.type === "select") assert.equal(fieldSchema.type, "string", `${q.id}: select needs string field`);

    // every choice question offers an escape hatch
    if (q.type === "select" || q.type === "multiselect") {
      assert.ok(Array.isArray(q.options) && q.options.length >= 3, `${q.id}: options missing`);
      assert.ok(q.options.includes("No preference"), `${q.id}: options must include "No preference"`);
      assert.ok(q.options.includes("Other"), `${q.id}: options must include "Other"`);
    }
  }

  // every schema group is covered by at least one question
  for (const group of groups) {
    assert.ok(
      questions.preferences.some((q) => q.group === group),
      `no preference questions for group ${group}`,
    );
  }
});

test("questions.json: interview bank is complete and well-formed", () => {
  assert.ok(Array.isArray(questions.interview));
  assert.ok(questions.interview.length >= 8 && questions.interview.length <= 12);

  const ids = new Set();
  for (const q of questions.interview) {
    for (const key of ["id", "label", "help", "type"]) {
      assert.ok(typeof q[key] === "string" && q[key].length > 0, `${q.id ?? "?"}: missing ${key}`);
    }
    assert.ok(typeof q.placeholder === "string", `${q.id}: placeholder must be a string`);
    assert.ok(["text", "textarea", "select", "multiselect"].includes(q.type), `${q.id}: bad type`);
    if (q.type === "select" || q.type === "multiselect") {
      assert.ok(Array.isArray(q.options) && q.options.length >= 2, `${q.id}: options missing`);
    }
    assert.ok(!ids.has(q.id), `duplicate interview id ${q.id}`);
    ids.add(q.id);
  }

  // the anchor questions exist
  for (const id of ["idea", "users", "app-kinds", "must-haves", "sign-in", "scale", "done-when"]) {
    assert.ok(ids.has(id), `interview bank missing "${id}"`);
  }
});

// ---------------------------------------------------------------------------
// Deepen + consistency-review prompts
// ---------------------------------------------------------------------------
import {
  buildDeepenPrompt,
  buildConsistencyReviewPrompt,
  PLAN_CONSISTENT_MARKER,
} from "./prompts.mjs";

test("buildDeepenPrompt embeds the plan, the spec, and the depth directives", () => {
  const prompt = buildDeepenPrompt({
    currentPlan: "# Garden Log build plan\n<!-- slug: garden-log -->",
    preferences: { version: 1, general: { languages: ["typescript"] } },
  });
  assert.ok(prompt.includes("# Garden Log build plan"));
  assert.ok(prompt.includes("PlanForge build-plan format"), "spec embedded");
  assert.ok(/implementation-ready/i.test(prompt));
  assert.ok(/Do NOT invent requirements/i.test(prompt));
  assert.ok(/split/i.test(prompt), "asks to split oversized slices");
  assert.ok(/typescript/i.test(prompt), "preferences summary present");
  assert.ok(/ledger row/i.test(prompt) || /ledger/i.test(prompt), "history preservation mentioned");
});

test("buildConsistencyReviewPrompt embeds the checklist and the two-form output rule", () => {
  const prompt = buildConsistencyReviewPrompt({
    currentPlan: "# Garden Log build plan",
    preferences: null,
    passNumber: 2,
  });
  assert.ok(prompt.includes("consistency pass 2"));
  assert.ok(prompt.includes(PLAN_CONSISTENT_MARKER));
  assert.ok(/blocked-on-Dx/.test(prompt), "decision-gate check present");
  assert.ok(/append-only/i.test(prompt), "ledger check present");
  assert.ok(/no stack preferences were set/i.test(prompt), "null prefs summary rendered");
  // Both output forms are described.
  assert.ok(/exactly one of two forms/i.test(prompt));
});

test("buildConsistencyReviewPrompt defaults a bad passNumber to 1", () => {
  const prompt = buildConsistencyReviewPrompt({ currentPlan: "x", passNumber: -3 });
  assert.ok(prompt.includes("consistency pass 1"));
});

// ---- resources: plans must derive backing services (esp. storage) from features ----
import { PLAN_FORMAT_SPEC as SPEC2 } from "./prompts.mjs";

test("the plan format requires a Resources enumeration with the uploads→storage rule", () => {
  assert.match(SPEC2, /\*\*Resources\*\*/);
  assert.match(SPEC2, /OBJECT\/FILE STORAGE/);
  assert.match(SPEC2, /not a database column/i);
});

test("the interview prompt tells the agent to provision resources it derives", () => {
  const p = buildInterviewPrompt({ answers: { idea: "upload photos and audio" }, preferences: null });
  assert.match(p, /Resources/);
  assert.match(p, /storage/i);
});

test("the consistency review checks resource completeness for upload features", () => {
  const p = buildConsistencyReviewPrompt({ currentPlan: "x", passNumber: 1 });
  assert.match(p, /Resource completeness/i);
  assert.match(p, /upload.*(photo|audio|video|file)/i);
  assert.match(p, /object\/file storage/i);
});
