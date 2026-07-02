#!/usr/bin/env node
// PlanForge orchestrator: a parallel, continuous build pool over the review chain.
//
// CONTINUOUS POOL (no per-round barrier): it keeps K workers busy at all times.
// (0) drains any review-clean worker PRs left over, then runs a steady loop:
//   - PLAN: a single serialized planner agent tops up a small buffer of
//     high-value slices from the build plans that are mutually NON-CONFLICTING
//     *and* disjoint from every slice currently in flight or already queued;
//   - BUILD: the moment any worker frees up, its slot is refilled from the buffer
//     — each worker is the unchanged review chain (core/review-chain.mjs) scoped
//     to one slice in its own fresh-default-branch worktree, building a
//     merge-ready PR;
//   - MERGE: as each worker finishes, its PR is merged in a serial lane, which
//     also refreshes the default branch so the planner's "unblocked" view stays
//     accurate. Branch hygiene runs after every merge pass.
//   - FIX: a reserved fix lane repairs failing/conflicting/stale-draft worker PRs
//     in parallel with new builds and auto-merges them once green.
// Planning, building, and merging all overlap, so wall-clock approaches
// total_work / K instead of sum-of-(slowest-worker-per-round).
//
// Everything environment-specific (workspace, repos, plans dir, pool sizing,
// providers, models) comes from planforge.config.json via core/config.mjs.
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  runShellStep,
  runGit,
  getPrMergeInfos,
  mergeCleanOpenPrs,
  formatMergeResults,
  discoverOpenPrs,
  cleanupGitRepos,
  defaultCodexCommand,
  expandTemplate,
  shellQuote,
  commandExists,
  buildReconcilePrompt,
  REFACTOR_DIRECTIVE,
} from './review-chain.mjs';
import { loadConfig } from './config.mjs';
import {
  selectRoles,
  detectExhaustedProviders,
  isForcedSameProvider,
  agentScriptFor,
  providerHasAgent,
} from './providers.mjs';

// Where these scripts live. The per-slice worker engine (the review chain) is
// resolved relative to this file, so the toolkit works from wherever it is
// installed or cloned.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CHAIN = join(SCRIPT_DIR, 'review-chain.mjs');
const MAX_PLAN_RETRIES = 3;
// Consecutive planner calls that return zero usable slices before we declare the
// plan "dry" and let the pool drain.
const MAX_EMPTY_PLANS = 2;
// Fix lane: how many times a worker may try to fix a still-failing PR before we
// give up on it, and how often (ms) we rescan GitHub for fixable worker PRs.
const MAX_FIX_ATTEMPTS = 2;
const FIX_SCAN_INTERVAL_MS = 120000;

// GitHub API rate-limit guard. The orchestrator's own gh calls (PR listing, merge
// lane, fix scan) plus the chain workers' gh usage can exhaust the API budget; a
// raw gh failure must NEVER crash the run. When we see a rate-limit error we cool
// off all gh-heavy orchestrator ops for a while and let it recover.
let ghCoolUntil = 0;
const ghCooling = () => Date.now() < ghCoolUntil;
function noteGhError(msg) {
  if (/rate limit|secondary rate|abuse detection|403/i.test(String(msg || ''))) {
    ghCoolUntil = Date.now() + 5 * 60 * 1000;
    console.warn('GitHub API rate-limited — pausing gh-heavy orchestrator ops for 5 min.');
  }
}

// Mirror the chain's forced-refactor cadence default (CHAIN_REFACTOR_EVERY env or 4).
function defaultRefactorEvery() {
  const n = Number.parseInt(process.env.CHAIN_REFACTOR_EVERY ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 4;
}

// ---------------------------------------------------------------------------
// Providers: config-driven priority selection with reactive quota failover.
// The chain has two role slots (CODEX_CHAIN_CMD = builder, CLAUDE_CHAIN_CMD =
// reviewer); we keep them pointed at the currently-selected provider pair by
// mutating process.env — the planner and every spawned worker read it, so a
// re-selection takes effect on the next launch.
// ---------------------------------------------------------------------------
const PROVIDER_COOLDOWN_MS = 60 * 60 * 1000; // exhausted provider sits out ~1h, then is retried

const providerLabel = (name) => (name ? name.charAt(0).toUpperCase() + name.slice(1) : '?');

// Point the chain's role slots (and prompt labels) at a provider pair.
function setRoleSlots(builder, reviewer) {
  process.env.CODEX_CHAIN_CMD = `${shellQuote(agentScriptFor(builder))} '{workspace}'`;
  process.env.CLAUDE_CHAIN_CMD = `${shellQuote(agentScriptFor(reviewer))} '{workspace}'`;
  process.env.CLAUDE_CHAIN_STDIN = '1'; // reviewer slot reads stdin like the builder slot
  process.env.CHAIN_BUILDER_LABEL = providerLabel(builder);
  process.env.CHAIN_REVIEWER_LABEL = providerLabel(reviewer);
}

// The agent scripts read their model/effort from these env vars; the config is
// the source of truth, so the orchestrator sets them once at startup.
function applyModelEnv(models) {
  process.env.CLAUDE_CHAIN_MODEL = models.claude;
  process.env.CLAUDE_CHAIN_FALLBACK_MODEL = models.claudeFallback;
  process.env.CLAUDE_CHAIN_EFFORT = models.claudeEffort;
  process.env.CODEX_CHAIN_MODEL = models.codex;
}

// Dynamic provider selection with reactive failover — the DEFAULT behavior.
// Providers come from config (providers.builderPriority / reviewerPriority);
// any provider name maps to core/agents/agent-<name>.sh. A provider whose agent
// script is missing is excluded up front; a provider that hits an
// out-of-credits / rate-limit wall is demoted for a cooldown, then retried.
export function createAutoProvider({ providers }) {
  const { builderPriority, reviewerPriority, dualRoleAllowed = ['claude'] } = providers;
  const names = [...new Set([...builderPriority, ...reviewerPriority])];
  const hasAgent = new Map(names.map((n) => [n, providerHasAgent(n)]));
  for (const [n, present] of hasAgent) {
    if (!present) {
      console.warn(`Provider "${n}" has no agent script at ${agentScriptFor(n)} — excluded from selection.`);
    }
  }
  const exhausted = new Map(); // provider -> ms timestamp it may be retried after
  // Optional hint: PLANFORGE_PROVIDERS_OUT="codex" (comma list) pre-marks providers
  // as out, so the run starts on the next-best pair instead of discovering it via a
  // failed call. Useful when you already know a provider is dry and don't want to
  // spend a planner/worker cycle finding out. Still reactive for everything else.
  for (const p of (process.env.PLANFORGE_PROVIDERS_OUT || '').split(/[,\s]+/).filter(Boolean)) {
    if (names.includes(p)) exhausted.set(p, Date.now() + 24 * 60 * 60 * 1000);
  }
  let current = { builder: null, reviewer: null };

  const available = () => {
    const now = Date.now();
    for (const [p, until] of exhausted) if (now >= until) exhausted.delete(p);
    return names.filter((p) => hasAgent.get(p) && !exhausted.has(p));
  };

  // Point the chain's role slots at the selected pair. Returns the roles (and
  // whether they changed) so callers can log/emit a switch.
  const sync = () => {
    const next = selectRoles(available(), { builderPriority, reviewerPriority, dualRoleAllowed });
    const changed = next.builder !== current.builder || next.reviewer !== current.reviewer;
    current = next;
    if (next.builder) setRoleSlots(next.builder, next.reviewer);
    return { ...current, changed };
  };

  // Scan a finished worker's log; demote whatever provider hit a wall (cooldown),
  // then re-sync. Returns the demoted providers + post-demotion roles, or null.
  const noteWorkerLog = (text) => {
    const hit = detectExhaustedProviders(text, [current.builder, current.reviewer].filter(Boolean));
    if (!hit.length) return null;
    for (const p of hit) exhausted.set(p, Date.now() + PROVIDER_COOLDOWN_MS);
    const roles = sync();
    return { demoted: hit, roles };
  };

  return {
    sync,
    noteWorkerLog,
    available,
    dualRoleAllowed,
    get roles() {
      return current;
    },
    describe: () => `${providerLabel(current.builder)} build / ${providerLabel(current.reviewer)} review`,
  };
}

// The planner + reconcile steps route through the builder slot for any provider.
function builderAgentCommand(workspace) {
  return {
    command: process.env.CODEX_CHAIN_CMD
      ? expandTemplate(process.env.CODEX_CHAIN_CMD, { workspace, logDir: '' })
      : defaultCodexCommand(workspace),
    appendPromptAsArg: false,
    streamJson: false,
  };
}

function usage() {
  console.log(`Usage:
  node ${join(SCRIPT_DIR, 'orchestrator.mjs')} [options]
  (or: planforge run [options])

Runs a CONTINUOUS POOL: a serialized planner surveys the build plans and keeps a
buffer of disjoint slices topped up, K workers build them in parallel worktrees
(each via core/review-chain.mjs --defer-merge), each PR merges in a serial lane
as its worker finishes, and a reserved fix lane repairs failing/conflicting PRs.
No per-round barrier — planning, building, and merging all overlap.

Workspace, repos, plans dir, pool sizing, providers, and models come from
planforge.config.json (see core/config.mjs / docs/ARCHITECTURE.md).

Options:
  --config <path>       Path to planforge.config.json (or a directory to search
                        upward from). Default: walk up from the current directory.
  --workers <n>         Override config "workers" (parallel build workers).
  --max-slices <n>      Override config "maxSlices" (total slice budget).
  --fix-workers <n>     Override config "fixWorkers" (workers reserved to fix
                        deferred failing/conflicting/stale-draft worker PRs).
  --no-fix              Disable the fix lane (build/merge only).
  --seed-slices <file>  Pre-load a JSON array of slices into the build queue BEFORE
                        the planner runs, for work the planner won't surface on its
                        own. Same slice shape as planner output
                        ({id,repo,title,kind,paths,rationale,notes}); each repo must
                        be in scope. The planner then tops up around them.
  --builder <name>      Pin the builder provider (escape hatch; disables the default
                        automatic provider selection/failover). Maps to
                        core/agents/agent-<name>.sh.
  --reviewer <name>     Pin the reviewer provider (same escape hatch).
  --refactor-every <N>  Force a behavior-preserving large-file refactor slice at a
                        density of one per N*workers launched slices, never two
                        refactors in flight at once. 0 = never. Default: ${defaultRefactorEvery()}
  --reconcile-every <N> Run a plan-reconcile pass (slice statuses + status-ledger
                        rows) every N*workers merged slices, concurrently with the
                        pool. 0 = end-of-run pass only. Default: 0
  --no-reconcile        Disable the plan reconcile pass entirely, including end-of-run.
  --no-deps-link        Skip the worktree node_modules linking (workers install deps).
  --plan-only           Run ONLY the planner (one agent call) and print the validated
                        slices + disjointness result. Spawns no workers, merges nothing.
  --dry-run             Print what each phase WOULD do (planner command + per-worker
                        spawn commands) without running any agent or git/gh write.
  --help                Show this help.

Environment:
  PLANFORGE_PROVIDERS_OUT   Comma list of providers to pre-mark exhausted, so the run
                        starts on the next-best pair.
  CODEX_CHAIN_* / CLAUDE_CHAIN_* / CHAIN_* env vars flow through to the chain workers.
`);
}

function parseArgs(argv) {
  const args = {
    config: null,
    workers: null,
    maxSlices: null,
    fixWorkers: null,
    seedSlices: null,
    builder: null,
    reviewer: null,
    refactorEvery: null,
    reconcileEvery: null,
    reconcile: true,
    depsLink: true,
    planOnly: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--config') {
      args.config = resolve(need());
    } else if (arg === '--workers') {
      args.workers = Number.parseInt(need(), 10);
    } else if (arg === '--max-slices') {
      args.maxSlices = Number.parseInt(need(), 10);
    } else if (arg === '--fix-workers') {
      args.fixWorkers = Number.parseInt(need(), 10);
    } else if (arg === '--no-fix') {
      args.fixWorkers = 0;
    } else if (arg === '--seed-slices') {
      args.seedSlices = resolve(need());
    } else if (arg === '--builder') {
      args.builder = need();
    } else if (arg === '--reviewer') {
      args.reviewer = need();
    } else if (arg === '--refactor-every') {
      args.refactorEvery = Number.parseInt(need(), 10);
    } else if (arg === '--reconcile-every') {
      args.reconcileEvery = Number.parseInt(need(), 10);
    } else if (arg === '--no-reconcile') {
      args.reconcile = false;
    } else if (arg === '--no-deps-link') {
      args.depsLink = false;
    } else if (arg === '--plan-only') {
      args.planOnly = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (args.workers !== null && (!Number.isInteger(args.workers) || args.workers < 1)) throw new Error('--workers must be a positive integer');
  if (args.maxSlices !== null && (!Number.isInteger(args.maxSlices) || args.maxSlices < 1)) throw new Error('--max-slices must be a positive integer');
  if (args.fixWorkers !== null && (!Number.isInteger(args.fixWorkers) || args.fixWorkers < 0)) throw new Error('--fix-workers must be a non-negative integer (0 disables the fix lane)');
  if (args.refactorEvery !== null && (!Number.isInteger(args.refactorEvery) || args.refactorEvery < 0)) throw new Error('--refactor-every must be a non-negative integer (0 disables)');
  if (args.reconcileEvery !== null && (!Number.isInteger(args.reconcileEvery) || args.reconcileEvery < 0)) throw new Error('--reconcile-every must be a non-negative integer (0 = end-of-run only)');
  return args;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Structured event stream (contract: docs/ARCHITECTURE.md §2). Every emit()
// appends one JSON object per line to <runDir>/events.ndjson AND mirrors it on
// stdout prefixed "@event " (the UI server tails the file; other tooling can
// scrape stdout). Telemetry must NEVER break a run, so both writes are
// best-effort and swallow errors.
export function createEmitter(runDir) {
  const path = join(runDir, 'events.ndjson');
  return (type, data = {}) => {
    let line;
    try {
      line = JSON.stringify({ t: Date.now(), type, ...data });
    } catch {
      return;
    }
    try {
      appendFileSync(path, `${line}\n`);
    } catch {
      /* ignore — telemetry is optional, the run is not */
    }
    try {
      process.stdout.write(`@event ${line}\n`);
    } catch {
      /* ignore */
    }
  };
}

function repoDirOf(repo, workspace) {
  return join(workspace, repo.includes('/') ? repo.split('/').pop() : repo);
}

// ---------------------------------------------------------------------------
// Planner: one serialized agent call -> up to K disjoint, unblocked, high-value
// slices as JSON, each also disjoint from everything already in flight.
// ---------------------------------------------------------------------------

// Rendered stack-preferences summary comes from the planning component (a pure
// function). Imported lazily so core stays importable before planning/ exists;
// tests inject their own planSome and never touch this.
let renderPreferencesSummaryFn = null;
async function renderPreferencesSummaryLazy(preferences) {
  if (!renderPreferencesSummaryFn) {
    try {
      ({ renderPreferencesSummary: renderPreferencesSummaryFn } = await import('../planning/prompts.mjs'));
    } catch {
      console.warn('planning/prompts.mjs not available — using a plain JSON preferences summary.');
      renderPreferencesSummaryFn = (p) => (p ? `Preferences (raw JSON):\n${JSON.stringify(p, null, 2)}` : '');
    }
  }
  try {
    return renderPreferencesSummaryFn(preferences ?? null) || '';
  } catch (e) {
    console.warn(`renderPreferencesSummary failed (${e.message}) — omitting the preferences summary.`);
    return '';
  }
}

function renderInFlight(inFlight) {
  if (!inFlight.length) return '';
  const lines = inFlight
    .map((s) => `  - [${s.repo}] ${s.id}: ${(s.paths || []).join(', ')}`)
    .join('\n');
  return `ALREADY IN FLIGHT — other workers are building these slices RIGHT NOW (or they are queued to build next). The slices you return MUST NOT touch ANY of these files: in the SAME repo, your "paths" must be disjoint from every path below; prefer a different repo or a different module to stay clear. Treat these exactly like a same-round conflict.
${lines}

`;
}

export function buildPlannerPrompt({ k, repos, feedback, refactorRound, inFlight = [], plansPath, preferencesSummary = '' }) {
  const constraint4 = refactorRound
    ? `4. REFACTOR SLICE: EXACTLY ONE of the slices you return must be a behavior-preserving large-file refactor — set its "kind":"refactor" and the rest "kind":"feature". Choose the refactor target with this guidance, and make its "paths" the file being split plus where its new modules will live so the feature slices can avoid them:\n${REFACTOR_DIRECTIVE}`
    : `4. Do NOT pick large-file refactors right now — they touch many files and collide with concurrent feature work. Pick feature slices from the build plans (all "kind":"feature").`;
  const prefsBlock = preferencesSummary
    ? `STACK PREFERENCES — the user's technology choices. Slices must be planned to honor them (and to honor any deviations each plan's "## 2. Architecture" section records):\n${preferencesSummary}\n\n`
    : '';
  return `You are the PLANNER for a continuous parallel build orchestrator. Choose UP TO ${k} work slices that can be built IN PARALLEL right now WITHOUT conflicting with each other OR with the work already in flight below. Return FEWER than ${k} (even just 1) if there is not that much genuinely non-conflicting, unblocked, high-value work available right now — NEVER pad the list with conflicting, blocked, or low-value slices. Return an empty array [] only if there is truly nothing actionable.

${renderInFlight(inFlight)}PLAN SOURCES — survey EVERY build plan in ${plansPath} (the files matching *-build-plan.md). Each plan uses the same house format:
  - "## 3. Open decisions" — decisions D1..Dn, each marked Proposed | Accepted | Blocked. Decisions GATE slices: a slice whose phase or status says blocked-on-Dx, where decision Dx is NOT Accepted, is NOT buildable — never pick it, no matter how valuable.
  - "## 4. Phases" — "### Phase N — <name>" sections, each listing that phase's slices with their id, title, paths, status (pending | building | shipped | blocked-on-Dx), and acceptance criteria. Honor phase order: never pull a later-phase slice before its prerequisite phases have merged. Only slices whose status is pending are candidates.
  - "## 5. Status ledger" — append-only verification history; use it to judge how current each plan's statuses are, and verify against the repos when in doubt.
Rank candidate slices ACROSS all plans and all in-scope repos, and spread the slices across different plans/repos when you can.

${prefsBlock}Repos you may target (a slice's repo MUST be one of these):
${repos.map((r) => `  - ${r}`).join('\n')}

Work from origin's default branch, NOT the local working trees (they may sit on stale branches): in each repo you consider, run \`git fetch origin\` and inspect the remote default branch and open PRs with gh. Confirm a slice is genuinely unblocked before choosing it.

HARD CONSTRAINTS for the slices you return:
1. Each slice is genuinely unblocked right now (its dependencies are already merged on the default branch, and it is not gated on a non-Accepted open decision).
2. Each slice is high value per its plan.
3. The slices are MUTUALLY NON-CONFLICTING and disjoint from everything ALREADY IN FLIGHT above. Two slices in DIFFERENT repos never conflict. Two slices in the SAME repo (or a slice and an in-flight item in the same repo) must touch DISJOINT files — their "paths" globs must not overlap. Prefer spreading slices across different repos and different modules to guarantee this.
${constraint4}
${feedback ? `\nFIX FROM THE PREVIOUS ATTEMPT (your last output was rejected):\n${feedback}\n` : ''}
OUTPUT FORMAT — after your survey, end your message with a SINGLE fenced code block (\`\`\`json ... \`\`\`) containing ONLY a JSON array of 0 to ${k} objects, and NOTHING after it:
[
  {
    "id": "kebab-case-stable-id",
    "repo": "owner/repo",
    "title": "short imperative title",
    "kind": "feature",
    "paths": ["apps/api/src/feature-*.ts", "packages/core/src/feature.ts"],
    "rationale": "why it is valuable AND why it is unblocked",
    "notes": "optional extra guidance for the worker building it"
  }
]
The "paths" must be specific enough to prove disjointness (concrete files or tight globs). Do not wrap multiple json blocks; emit exactly one.`;
}

export function extractJsonArray(text) {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidates = [];
  if (fences.length > 0) candidates.push(fences[fences.length - 1][1]);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const arr = JSON.parse(c.trim());
      if (Array.isArray(arr)) return arr;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// Glob -> RegExp (single-segment * , recursive ** ).
export function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// Two glob lists overlap if any pair could match a common path. Specific files in
// the same directory do NOT count as overlapping (workers may edit sibling files);
// a wildcard that covers the other's path does.
export function pathsOverlap(a = [], b = []) {
  for (const ga of a) {
    for (const gb of b) {
      if (ga === gb) return ga;
      const ra = globToRegex(ga);
      const rb = globToRegex(gb);
      const la = ga.replace(/\*+/g, 'x');
      const lb = gb.replace(/\*+/g, 'x');
      if (ra.test(lb) || rb.test(la)) return `${ga} ⨯ ${gb}`;
    }
  }
  return null;
}

// Validate a planner batch of up to k slices. `inFlight` is the set of slices the
// pool is already building (or has queued); a new slice must be disjoint from each
// of them too, so concurrent builds never touch the same files. An empty result is
// allowed (the plan is dry) — `empty` reports that distinctly from a hard failure.
export function validateSlices(arr, k, repos, inFlight = []) {
  const problems = [];
  const slices = [];
  if (!Array.isArray(arr)) return { ok: false, empty: false, slices: [], problems: ['planner did not return a JSON array'] };
  arr.forEach((s, i) => {
    if (!s || typeof s !== 'object') return problems.push(`slice ${i} is not an object`);
    if (!s.id || typeof s.id !== 'string') return problems.push(`slice ${i} missing string "id"`);
    if (!s.repo || !repos.includes(s.repo)) return problems.push(`slice "${s.id}" has repo "${s.repo}" not in scope`);
    if (!Array.isArray(s.paths) || s.paths.length === 0) return problems.push(`slice "${s.id}" needs a non-empty "paths" array`);
    slices.push({ ...s, kind: s.kind === 'refactor' ? 'refactor' : 'feature' });
  });
  // Disjointness: only same-repo pairs can conflict.
  for (let i = 0; i < slices.length; i += 1) {
    for (let j = i + 1; j < slices.length; j += 1) {
      if (slices[i].repo !== slices[j].repo) continue;
      const clash = pathsOverlap(slices[i].paths, slices[j].paths);
      if (clash) problems.push(`slices "${slices[i].id}" and "${slices[j].id}" overlap in ${slices[i].repo}: ${clash}`);
    }
  }
  // Same check against everything already in flight / queued.
  for (const s of slices) {
    for (const f of inFlight) {
      if (s.repo !== f.repo) continue;
      const clash = pathsOverlap(s.paths, f.paths);
      if (clash) problems.push(`slice "${s.id}" overlaps in-flight "${f.id}" in ${s.repo}: ${clash}`);
    }
  }
  const ids = slices.map((s) => s.id);
  if (new Set(ids).size !== ids.length) problems.push('duplicate slice ids');
  const inFlightIds = new Set(inFlight.map((f) => f.id));
  for (const s of slices) {
    if (inFlightIds.has(s.id)) problems.push(`slice "${s.id}" duplicates an in-flight slice id`);
  }
  return {
    ok: problems.length === 0 && slices.length >= 1,
    empty: problems.length === 0 && slices.length === 0,
    slices: slices.slice(0, k),
    problems,
  };
}

// One planner agent call (with validation retries) -> up to `k` slices that are
// disjoint from each other AND from `inFlight`. Returns { slices, empty }:
//   slices non-empty -> launch them; empty:true -> planner found nothing actionable
//   right now (counts toward the dry threshold); empty:false + [] -> hard failure.
// Callers serialize these so each call sees the latest in-flight set.
async function planSome({ k, repos, inFlight, logDir, logTag, refactorRound, workspace, plansPath, preferences }) {
  const plan = builderAgentCommand(workspace);
  const preferencesSummary = await renderPreferencesSummaryLazy(preferences);
  let feedback = '';
  let lastLogPath = null; // returned so the failover can scan it for provider exhaustion
  for (let attempt = 1; attempt <= MAX_PLAN_RETRIES; attempt += 1) {
    let out = '';
    lastLogPath = join(logDir, `plan-${logTag}-${attempt}.log`);
    try {
      out = await runShellStep({
        label: `Planner ${logTag} (attempt ${attempt}/${MAX_PLAN_RETRIES}, up to ${k} slices, ${inFlight.length} in flight)`,
        command: plan.command,
        prompt: buildPlannerPrompt({ k, repos, feedback, refactorRound, inFlight, plansPath, preferencesSummary }),
        cwd: workspace,
        logPath: lastLogPath,
        appendPromptAsArg: plan.appendPromptAsArg,
        dryRun: false,
        streamJson: plan.streamJson,
        fallback: null,
      });
    } catch (e) {
      console.warn(`\nPlanner ${logTag} attempt ${attempt} threw: ${e.message}`);
      feedback = `The previous attempt errored before returning a plan. Return 0 to ${k} valid, disjoint slices as one json array.`;
      continue;
    }
    const arr = extractJsonArray(out);
    const { ok, empty, slices, problems } = validateSlices(arr, k, repos, inFlight);
    if (empty) return { slices: [], empty: true, logPath: lastLogPath };
    if (ok) {
      if (refactorRound && !slices.some((s) => s.kind === 'refactor')) {
        slices[0].kind = 'refactor';
        console.warn('Refactor due: planner did not flag a refactor slice; marking the first as refactor.');
      }
      writeFileSync(join(logDir, `plan-${logTag}.json`), JSON.stringify(slices, null, 2));
      return { slices, empty: false, logPath: lastLogPath };
    }
    feedback = `Problems: ${problems.join('; ')}. Return 0 to ${k} valid slices, each disjoint from the others and from everything already in flight, as one json array.`;
    console.warn(`\nPlanner ${logTag} attempt ${attempt} rejected: ${problems.join('; ')}`);
  }
  console.error(`\nPlanner ${logTag} failed to produce a valid plan after ${MAX_PLAN_RETRIES} attempts.`);
  return { slices: [], empty: false, logPath: lastLogPath };
}

// ---------------------------------------------------------------------------
// Worktrees: one per worker, off the FRESH remote default branch, with the
// repo's own workspace packages linked so typecheck/tests don't resolve stale
// copies from the main checkout.
// ---------------------------------------------------------------------------

function discoverWorkspaceDirs(wtPath) {
  const pjPath = join(wtPath, 'package.json');
  if (!existsSync(pjPath)) return [];
  const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
  const globs = Array.isArray(pj.workspaces) ? pj.workspaces : pj.workspaces?.packages || [];
  const dirs = [];
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const base = g.slice(0, -2);
      const baseAbs = join(wtPath, base);
      if (!existsSync(baseAbs)) continue;
      for (const d of readdirSync(baseAbs)) {
        if (statSync(join(baseAbs, d)).isDirectory()) dirs.push(join(base, d));
      }
    } else if (existsSync(join(wtPath, g))) {
      dirs.push(g);
    }
  }
  return dirs;
}

// Symlink every third-party node_modules entry from the main checkout into the
// worktree, but rebuild the npm-workspace package links to point at the
// worktree's OWN packages. Never mutates the main checkout's node_modules.
export function linkWorkspaceNodeModules(wtPath, repoDir) {
  const srcNm = join(repoDir, 'node_modules');
  if (!existsSync(srcNm)) return { linked: false, reason: 'no source node_modules' };
  const dstNm = join(wtPath, 'node_modules');
  rmSync(dstNm, { recursive: true, force: true });
  mkdirSync(dstNm, { recursive: true });

  const wsDirs = discoverWorkspaceDirs(wtPath);
  const scopes = new Set(); // scope dirs we will rebuild ourselves, e.g. "@myscope"
  const scopedLinks = []; // [{scope, short, target}]
  for (const rel of wsDirs) {
    const pjPath = join(wtPath, rel, 'package.json');
    if (!existsSync(pjPath)) continue;
    const name = JSON.parse(readFileSync(pjPath, 'utf8')).name;
    if (!name) continue;
    if (name.startsWith('@')) {
      const [scope, short] = name.split('/');
      scopes.add(scope);
      scopedLinks.push({ scope, short, target: join(wtPath, rel) });
    } else {
      scopedLinks.push({ scope: null, short: name, target: join(wtPath, rel) });
    }
  }

  for (const entry of readdirSync(srcNm)) {
    if (scopes.has(entry)) continue; // rebuilt below
    if (scopedLinks.some((l) => l.scope === null && l.short === entry)) continue;
    symlinkSync(join(srcNm, entry), join(dstNm, entry));
  }
  for (const scope of scopes) mkdirSync(join(dstNm, scope), { recursive: true });
  for (const { scope, short, target } of scopedLinks) {
    const linkPath = scope ? join(dstNm, scope, short) : join(dstNm, short);
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(target, linkPath);
  }
  return { linked: true, workspacePkgs: scopedLinks.length };
}

// Resolve a repo's default branch — most are "main", but some use "master" and
// have no "main" ref at all, so a hard-coded "main" would make every worker for
// that repo die in prepWorktree. Prefer the local origin/HEAD symref, fall back
// to asking the remote, then "main". Cached per repo (prepWorktree runs once per
// worker launch).
const defaultBranchCache = new Map();
export function resolveDefaultBranch(repoDir) {
  if (defaultBranchCache.has(repoDir)) return defaultBranchCache.get(repoDir);
  let branch = '';
  const local = runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repoDir);
  if (local.status === 0) branch = (local.stdout || '').trim().replace(/^origin\//, '');
  if (!branch) {
    const remote = runGit(['ls-remote', '--symref', 'origin', 'HEAD'], repoDir);
    const m = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(remote.status === 0 ? (remote.stdout || '') : '');
    if (m) branch = m[1];
  }
  branch = branch || 'main';
  defaultBranchCache.set(repoDir, branch);
  return branch;
}

export function prepWorktree(slice, workerId, workspace, depsLink) {
  const repoDir = repoDirOf(slice.repo, workspace);
  if (!existsSync(join(repoDir, '.git'))) throw new Error(`local checkout missing: ${repoDir}`);
  const base = resolveDefaultBranch(repoDir);
  const fetch = runGit(['fetch', 'origin', base], repoDir);
  if (fetch.status !== 0) throw new Error(`git fetch origin ${base} failed: ${fetch.stderr}`);

  const wtPath = join(workspace, '.planforge', 'worktrees', `worker-${workerId}`);
  const branch = `worker-${workerId}/${slice.id}`;
  runGit(['worktree', 'remove', '--force', wtPath], repoDir);
  runGit(['worktree', 'prune'], repoDir);
  rmSync(wtPath, { recursive: true, force: true });
  runGit(['branch', '-D', branch], repoDir); // drop any stale local branch of this name
  const add = runGit(['worktree', 'add', '--force', '-B', branch, wtPath, `origin/${base}`], repoDir);
  if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);

  if (depsLink) {
    try {
      const r = linkWorkspaceNodeModules(wtPath, repoDir);
      if (r.linked) console.log(`[w${workerId}] linked node_modules (${r.workspacePkgs} workspace pkgs -> worktree)`);
      else console.log(`[w${workerId}] node_modules link skipped: ${r.reason}`);
    } catch (e) {
      console.warn(`[w${workerId}] node_modules link failed: ${e.message} (worker may need to install deps)`);
    }
  }
  return { wtPath, branch };
}

// ---------------------------------------------------------------------------
// Worker: the review chain, scoped to one slice in its worktree.
// ---------------------------------------------------------------------------

function spawnChain(argv, label, logPath, workspace) {
  return new Promise((resolveP) => {
    mkdirSync(dirname(logPath), { recursive: true });
    const out = createWriteStream(logPath, { flags: 'w' });
    out.write(`$ node ${CHAIN} ${argv.join(' ')}\n\n`);
    const child = spawn('node', [CHAIN, ...argv], { cwd: workspace, env: process.env });
    let buf = '';
    const onData = (chunk) => {
      const t = chunk.toString();
      out.write(t);
      buf += t;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) process.stdout.write(`[${label}] ${line}\n`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      if (buf.trim()) process.stdout.write(`[${label}] ${buf}\n`);
      out.end(`\n\nEXIT_CODE: ${code}\n`);
      resolveP(code);
    });
    child.on('error', (err) => {
      out.end(`\n\nSPAWN_ERROR: ${err.message}\n`);
      console.error(`[${label}] spawn error: ${err.message}`);
      resolveP(-1);
    });
  });
}

// `slotId` is the reusable worker slot (1..K) — it names the worktree/branch and
// the chain's --pr-scope. `workerDir` is a unique per-slice directory so logs from
// successive slices that reuse a slot never collide.
async function runWorker(assignment, workerDir, args) {
  const { slotId, slice } = assignment;
  const label = `w${slotId}`;
  mkdirSync(workerDir, { recursive: true });
  const slicePath = join(workerDir, 'slice.json');
  writeFileSync(slicePath, JSON.stringify(slice, null, 2));

  let wt;
  try {
    wt = prepWorktree(slice, slotId, args.workspace, args.depsLink);
  } catch (e) {
    console.error(`[${label}] worktree prep failed: ${e.message}`);
    return { ...assignment, ok: false, reason: `worktree: ${e.message}` };
  }

  const argv = [
    '--workspace', wt.wtPath,
    '--log-dir', join(workerDir, 'chain'),
    '--slice-file', slicePath,
    '--pr-scope', `worker-${slotId}`,
    '--defer-merge',
    '--no-discover-open-prs',
    '--no-reconcile',
    '--no-cleanup',
    '--loops', '1',
    '--allow-repo', slice.repo,
  ];

  console.log(`[${label}] building "${slice.id}" in ${slice.repo} on ${wt.branch}`);
  const code = await spawnChain(argv, label, join(workerDir, 'worker.log'), args.workspace);
  console.log(`[${label}] chain exited ${code}`);
  return { ...assignment, ok: code === 0, branch: wt.branch, logPath: join(workerDir, 'worker.log') };
}

// Fix lane: run the chain scoped to ONE existing failing/conflicting worker PR
// (--prs <n>). The chain's open-PR-queue prompt makes it fix failing checks,
// resolve conflicts, and mark the PR ready; the merge lane then lands it when
// clean. A clean fresh worktree is enough — the agent checks out the PR via gh.
async function runFixWorker(item, workerDir, slotId, args) {
  const label = `fix-w${slotId}`;
  mkdirSync(workerDir, { recursive: true });
  let wt;
  try {
    wt = prepWorktree({ repo: item.repo, id: `fix-${item.number}` }, slotId, args.workspace, args.depsLink);
  } catch (e) {
    console.error(`[${label}] worktree prep failed: ${e.message}`);
    return { ...item, ok: false, reason: `worktree: ${e.message}` };
  }
  const argv = [
    '--workspace', wt.wtPath,
    '--log-dir', join(workerDir, 'chain'),
    '--prs', String(item.number),
    '--no-discover-open-prs',
    '--defer-merge',
    '--no-reconcile',
    '--no-cleanup',
    '--loops', '1',
    '--allow-repo', item.repo,
  ];
  console.log(`[${label}] fixing ${item.repo}#${item.number} (${item.state})`);
  const code = await spawnChain(argv, label, join(workerDir, 'worker.log'), args.workspace);
  console.log(`[${label}] chain exited ${code}`);
  return { ...item, ok: code === 0, logPath: join(workerDir, 'worker.log') };
}

// ---------------------------------------------------------------------------
// Serial merge lane / drain: only ever touches agent-branch PRs.
// ---------------------------------------------------------------------------

// Branches the orchestrator manages (merges + fixes). The pool's own workers push
// to worker-*/, but agents don't always honor the assigned worker-* branch and
// open their own codex/* (and sometimes slice/*) PRs — so we treat all agent
// branch conventions as managed, otherwise that work piles up unmerged.
const AGENT_BRANCH_PREFIXES = ['worker-', 'codex/', 'slice/'];
const isAgentBranch = (name) => typeof name === 'string' && AGENT_BRANCH_PREFIXES.some((p) => name.startsWith(p));

// Open agent-branch PRs that need fixing: a conflict (DIRTY) or a not-mergeable
// check state (UNSTABLE/BLOCKED/BEHIND). We classify by mergeStateStatus alone —
// the per-PR statusCheckRollup is far too expensive on the GraphQL budget to poll
// a few hundred PRs every scan. Clean PRs (CLEAN/HAS_HOOKS) are left to the merge
// lane; UNKNOWN (still computing) is skipped.
export function findFixablePrs(repos, activeBranches = new Set()) {
  if (ghCooling()) return [];
  const FIXABLE = new Set(['DIRTY', 'UNSTABLE', 'BLOCKED', 'BEHIND']);
  const out = [];
  for (const repo of repos) {
    const r = spawnSync(
      'gh',
      ['pr', 'list', '-R', repo, '--state', 'open', '-L', '150', '--json', 'number,headRefName,mergeStateStatus,isDraft'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (r.status !== 0) { noteGhError(r.stderr); continue; }
    let arr;
    try { arr = JSON.parse(r.stdout); } catch { continue; }
    for (const p of arr) {
      if (!isAgentBranch(p.headRefName)) continue;
      // A draft whose worker is no longer building = an unfinished review (worker
      // died or gave up mid-chain). The merge lane refuses to ready drafts, so send
      // it through the fix lane where an agent finishes the review and marks it
      // ready — never merge unreviewed work, never leave it to rot either.
      if (p.isDraft) {
        if (!activeBranches.has(p.headRefName)) out.push({ repo, number: p.number, branch: p.headRefName, state: 'DRAFT' });
        continue;
      }
      if (FIXABLE.has(p.mergeStateStatus)) out.push({ repo, number: p.number, branch: p.headRefName, state: p.mergeStateStatus });
    }
  }
  return out;
}

function findWorkerPrs(repos, workspace) {
  const all = discoverOpenPrs(repos, workspace);
  if (all.length === 0) return [];
  const infos = getPrMergeInfos(all, workspace);
  return all.filter((ref) => {
    const info = infos.get(ref);
    return info && isAgentBranch(info.headRefName);
  });
}

// Branch hygiene: leave no abandoned branches behind. Runs after every merge pass,
// scoped to the pass's repos. Three layers:
//   1. the chain's cleanupGitRepos — prune worktrees, drop local branches whose
//      upstream is [gone] (i.e. deleted on GitHub by --delete-branch);
//   2. local + remote agent-prefixed branches whose PR is MERGED or CLOSED — the
//      auto merge queue and worker self-merges historically left these behind;
//   3. local worker-*/ branches with no open PR at all — the pool owns that
//      namespace, so no-PR means the worker died before opening one. A LIVE
//      worker's branch is checked out in its worktree, so `branch -D` refuses and
//      the branch survives until the worktree is gone (removeWorktrees at drain-final).
// Every step is best-effort: a git/gh failure logs and moves on, never crashes the run.
export function agentBranchCleanup(repos, label, logDir, { removeWorktrees = false, workspace } = {}) {
  const lines = [];
  try {
    for (const r of cleanupGitRepos(repos, workspace)) lines.push(`${r.repo}: ${r.actions.join('; ')}`);
  } catch (e) { lines.push(`chain cleanup failed: ${e.message}`); }
  for (const repo of repos) {
    try {
      const dir = repoDirOf(repo, workspace);
      if (!existsSync(join(dir, '.git'))) continue;
      if (removeWorktrees) {
        const list = runGit(['worktree', 'list', '--porcelain'], dir).stdout || '';
        for (const m of list.matchAll(/^worktree (.+)$/gm)) {
          const p = m[1].trim();
          if (p.includes(`${sep}.planforge${sep}worktrees${sep}`)) runGit(['worktree', 'remove', '--force', p], dir);
        }
        runGit(['worktree', 'prune'], dir);
      }
      runGit(['fetch', '--prune', 'origin'], dir);
      const dead = new Set();
      const openHeads = new Set();
      let openOk = false;
      if (!ghCooling()) {
        for (const state of ['merged', 'closed']) {
          const r = spawnSync('gh', ['pr', 'list', '-R', repo, '--state', state, '-L', '100', '--json', 'headRefName'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          if (r.status !== 0) { noteGhError(r.stderr); continue; }
          try { for (const p of JSON.parse(r.stdout)) if (isAgentBranch(p.headRefName)) dead.add(p.headRefName); } catch { /* skip */ }
        }
        const ro = spawnSync('gh', ['pr', 'list', '-R', repo, '--state', 'open', '-L', '150', '--json', 'headRefName'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (ro.status === 0) {
          try { for (const p of JSON.parse(ro.stdout)) openHeads.add(p.headRefName); openOk = true; } catch { /* skip */ }
        } else noteGhError(ro.stderr);
      }
      const locals = (runGit(['for-each-ref', '--format', '%(refname:short)', 'refs/heads'], dir).stdout || '')
        .split('\n').filter(Boolean);
      for (const b of locals) {
        if (!isAgentBranch(b)) continue;
        const prDead = dead.has(b) && !openHeads.has(b);
        const orphanWorker = b.startsWith('worker-') && openOk && !openHeads.has(b);
        if (!prDead && !orphanWorker) continue;
        const del = runGit(['branch', '-D', b], dir);
        if (del.status === 0) lines.push(`${repo}: branch -D ${b}`);
      }
      const remotes = (runGit(['for-each-ref', '--format', '%(refname:short)', 'refs/remotes/origin'], dir).stdout || '')
        .split('\n').map((s) => s.replace(/^origin\//, '')).filter(Boolean);
      const remoteDead = remotes.filter((b) => isAgentBranch(b) && dead.has(b) && !openHeads.has(b));
      if (remoteDead.length) {
        const del = runGit(['push', 'origin', '--delete', ...remoteDead], dir);
        if (del.status !== 0) for (const b of remoteDead) runGit(['push', 'origin', '--delete', b], dir); // one bad ref aborts a batch — retry singly
        lines.push(`${repo}: deleted ${remoteDead.length} merged/closed remote branch(es)`);
      }
    } catch (e) { lines.push(`${repo}: cleanup failed: ${e.message}`); }
  }
  if (lines.length) {
    console.log(`${label}: branch hygiene —\n${lines.map((l) => `  - ${l}`).join('\n')}`);
    if (logDir) {
      try { mkdirSync(logDir, { recursive: true }); writeFileSync(join(logDir, 'cleanup.log'), `${lines.join('\n')}\n`); } catch { /* best-effort */ }
    }
  }
}

// Returns the PR refs that actually merged now (not just queued via --auto), so
// the reconcile pass can reflect them. A gh failure (rate limit, network) must
// NEVER crash the run: catch, note it, and skip — the next pass retries.
function mergeWorkerPrs(repos, label, logDir, workspace) {
  if (ghCooling()) { console.log(`${label}: skipped (gh cooling off after rate limit).`); return []; }
  let mergedNow = [];
  try {
    const prs = findWorkerPrs(repos, workspace);
    if (prs.length === 0) {
      console.log(`${label}: no open worker PRs.`);
    } else {
      console.log(`${label}: ${prs.length} worker PR(s): ${prs.join(', ')}`);
      // readyDrafts:false — a draft here means the worker never finished its review;
      // the fix lane finishes it. Force-readying drafts merged unreviewed work in
      // repos without CI, which is exactly the "job not done right" failure mode.
      const results = mergeCleanOpenPrs(prs, workspace, { readyDrafts: false });
      const formatted = formatMergeResults(results);
      if (logDir) {
        mkdirSync(logDir, { recursive: true });
        writeFileSync(join(logDir, 'merge.log'), `${formatted}\n`);
      }
      console.log(formatted);
      mergedNow = results.filter((r) => r.status === 0 && /pr merge/.test(r.command) && !/--auto/.test(r.command)).map((r) => r.pr);
    }
  } catch (e) {
    noteGhError(e.message);
    console.warn(`${label}: merge pass failed (non-fatal): ${e.message}`);
  }
  agentBranchCleanup(repos, label, logDir, { workspace });
  return mergedNow;
}

// End-of-run / cadence plan reconcile — reuses the chain's reconcile prompt to
// keep the build plans' slice statuses + status ledgers consistent with what
// merged this run.
async function runReconcile({ repos, mergedPrs, roles, passLabel, logPath, workspace, plansPath }) {
  if (!existsSync(plansPath)) {
    console.warn(`Reconcile skipped: plans directory ${plansPath} does not exist.`);
    return;
  }
  const agent = builderAgentCommand(workspace);
  const date = new Date().toISOString().slice(0, 10);
  await runShellStep({
    label: `Reconcile plans (${passLabel})`,
    command: agent.command,
    prompt: buildReconcilePrompt({
      passLabel,
      plansDir: plansPath,
      prs: [...new Set(mergedPrs)],
      repos,
      date,
      roles,
    }),
    cwd: workspace,
    logPath,
    appendPromptAsArg: agent.appendPromptAsArg,
    dryRun: false,
    streamJson: agent.streamJson,
    fallback: null,
  });
}

// ---------------------------------------------------------------------------
// Pool driver: keep K workers busy, refilling each freed slot immediately from a
// planner-fed buffer; merge + plan + build all overlap. No per-round barrier.
// ---------------------------------------------------------------------------

export async function runPool({ args, runDir, roles, sliceBudget, emit = () => {}, deps = {}, auto = null }) {
  // Seams for deterministic testing; default to the real agent/git-backed fns.
  const planSomeFn = deps.planSome || planSome;
  const runWorkerFn = deps.runWorker || runWorker;
  const mergeFn = deps.mergeWorkerPrs || ((repos, label, logDir) => mergeWorkerPrs(repos, label, logDir, args.workspace));
  const reconcileFn = deps.runReconcile || runReconcile;
  const findFixablePrsFn = deps.findFixablePrs || findFixablePrs;
  const runFixWorkerFn = deps.runFixWorker || runFixWorker;
  const repos = args.repos;
  const K = args.workers;
  const plansPath = args.plansPath || join(args.workspace, args.plansDir || 'plans');
  // Fix lane: up to fixCap of the K workers fix deferred (failing/conflicting)
  // worker PRs in parallel with the build lane; 0 disables it.
  const fixCap = Math.min(K, Math.max(0, args.fixWorkers || 0));
  // Density translations of per-round cadences into the round-less pool:
  // one refactor / one reconcile per N*workers slices ≈ "every Nth round".
  const refactorEverySlices = args.refactorEvery >= 1 ? args.refactorEvery * K : 0;
  const reconcileEverySlices = args.reconcile && args.reconcileEvery >= 1 ? args.reconcileEvery * K : 0;
  const startedAt = Date.now();
  emit('run-start', {
    runId: runDir.split(/[\\/]/).pop(),
    workers: K,
    budget: sliceBudget,
    repos,
    builder: roles.builder,
    reviewer: roles.reviewer,
    fixWorkers: fixCap,
    refactorEverySlices,
    reconcileEverySlices,
  });

  // Reactive failover: after a worker finishes, scan its log; if the builder or
  // reviewer provider hit an out-of-credits / rate-limit wall, demote it and
  // re-point the role slots at the next pair. The next planner call and worker
  // launch pick up the new providers automatically (they read process.env, which
  // sync() mutates).
  const reactToWorkerLog = (result) => {
    if (!auto || !result?.logPath) return null;
    let text = '';
    try { text = readFileSync(result.logPath, 'utf8'); } catch { return null; }
    if (text.length > 200_000) text = text.slice(-200_000); // the tail is where errors land
    const switched = auto.noteWorkerLog(text);
    if (switched) {
      console.warn(`[providers] ${switched.demoted.join(', ')} hit a limit -> ${auto.describe()}`);
      emit('provider-switch', { demoted: switched.demoted, builder: switched.roles.builder, reviewer: switched.roles.reviewer });
    }
    return switched;
  };
  // Periodically re-select in case a cooled-down provider recovered.
  const maybeResyncProviders = () => {
    if (!auto) return;
    const r = auto.sync();
    if (r.changed) {
      console.log(`[providers] availability changed -> ${auto.describe()}`);
      emit('provider-switch', { builder: r.builder, reviewer: r.reviewer, demoted: [], reason: 'availability' });
    }
  };

  const mergedPrs = [];
  const inFlight = new Map(); // slotId -> { slice } currently building
  const ready = []; // planned, validated, not yet launched
  const active = new Map(); // slotId -> Promise<{ slotId, result }>
  let launchedCount = 0;
  // Seed by K so the FIRST forced refactor lands after (every-1)*K feature launches,
  // matching a per-round loop (where the refactor sat inside the Nth round) instead
  // of waiting a full every*K — otherwise the cadence runs systematically late.
  let launchedSinceRefactor = refactorEverySlices > 0 ? K : 0;
  let mergedSliceCount = 0;
  let reconciledAtMerge = 0;
  let emptyPlans = 0;
  let dry = false;
  let planningPromise = null;
  let reconciling = false;
  let failedCount = 0;
  const pendingReconciles = [];
  // Fix-lane state. fixInFlight: slotId -> item being fixed; fixReady: discovered
  // fixable PRs awaiting a slot; fixAttempts: per-PR try count; fixDry: last scan
  // found nothing fixable and none are in flight.
  const fixInFlight = new Map();
  let fixReady = [];
  const fixAttempts = new Map();
  let lastFixScan = 0;
  let fixDry = false;
  let fixedCount = 0;
  const prKey = (it) => `${it.repo}#${it.number}`;

  // Snapshot the authoritative counters for the stats event (contract §2).
  const emitStats = (extra = {}) =>
    emit('stats', {
      launched: launchedCount,
      budget: sliceBudget,
      inFlight: active.size,
      queued: ready.length,
      mergedPrs: [...new Set(mergedPrs)].length,
      mergedSlices: mergedSliceCount,
      failed: failedCount,
      dry,
      fixing: fixInFlight.size,
      fixQueued: fixReady.length,
      fixed: fixedCount,
      elapsedMs: Date.now() - startedAt,
      ...extra,
    });

  const freeSlotId = () => {
    for (let i = 1; i <= K; i += 1) if (!active.has(i)) return i;
    return null;
  };
  // Everything the planner must avoid: building now + queued to build next.
  const exclusionSet = () => [...[...inFlight.values()].map((x) => x.slice), ...ready];
  // The reconcile pass edits the plan documents; if the plans dir lives inside
  // one of the repos being built right now, both would touch that repo at once.
  const plansBusy = () =>
    exclusionSet().some((s) => {
      const dir = repoDirOf(s.repo, args.workspace);
      return plansPath === dir || plansPath.startsWith(dir + sep);
    });
  // A forced refactor is due once we've launched enough slices since the last one,
  // but never while a refactor is already in flight/queued (two at once collide).
  const refactorDue = () => {
    if (refactorEverySlices === 0) return false;
    if ([...inFlight.values()].some((x) => x.slice.kind === 'refactor') || ready.some((s) => s.kind === 'refactor')) return false;
    return launchedSinceRefactor >= refactorEverySlices;
  };

  // Serialized planner top-up. Joins an in-flight plan if one is already running so
  // callers never spawn two concurrent planner agents or busy-spin waiting on one.
  function pump() {
    if (planningPromise) return planningPromise;
    const slack = K - active.size - ready.length; // free pool capacity not already queued
    const budgetLeft = sliceBudget - launchedCount - ready.length;
    const want = Math.min(slack, budgetLeft);
    if (dry || want < 1) return Promise.resolve();
    const inFlightList = exclusionSet();
    // Only an empty plan against an EMPTY baseline (nothing in flight or queued) is
    // evidence the backlog is truly exhausted. An empty plan while work is in flight
    // just means "nothing else fits alongside it yet" — the idle slots wait; a
    // finishing+merging worker frees paths / advances the default branch and opens
    // up more.
    const baselineEmpty = inFlightList.length === 0;
    const refactorRound = refactorDue();
    const tag = `s${String(launchedCount + ready.length + 1).padStart(3, '0')}`;
    const noteNoWork = (why) => {
      if (baselineEmpty) {
        emptyPlans += 1;
        console.warn(`Planner ${tag}: ${why} with an idle pool (${emptyPlans}/${MAX_EMPTY_PLANS}).`);
        emit('plan-result', { tag, status: 'empty', queued: 0, ids: [], reason: why, emptyPlans });
        if (emptyPlans >= MAX_EMPTY_PLANS) {
          dry = true;
          console.log('Plan is dry — draining the pool and finishing up.');
          emit('dry', { reason: why });
        }
      } else {
        const busy = active.size + ready.length;
        const idle = K - busy;
        console.log(`Planner ${tag}: ${why}; pool saturated at ${busy}/${K} — ${idle} worker(s) idle, waiting for in-flight work to merge/unblock.`);
        emit('plan-result', { tag, status: 'saturated', queued: 0, ids: [], reason: why, busy, idle });
      }
      emitStats();
    };
    emit('plan-start', { tag, want, inFlight: inFlightList.length, refactor: refactorRound });
    planningPromise = (async () => {
      try {
        const planResult = await planSomeFn({
          k: want,
          repos,
          inFlight: inFlightList,
          logDir: runDir,
          logTag: tag,
          roles,
          refactorRound,
          workspace: args.workspace,
          plansPath,
          preferences: args.preferences ?? null,
        });
        const { slices, empty } = planResult;
        // Failover: if the planner ran on a builder that's out of credits /
        // rate-limited, demote it and re-select so the NEXT plan attempt uses an
        // available provider — a provider-exhaustion failure must not count toward
        // the "dry" backlog signal.
        const switched = reactToWorkerLog({ logPath: planResult.logPath });
        if (slices.length) {
          emptyPlans = 0;
          ready.push(...slices);
          console.log(`Planner ${tag}: queued ${slices.length} slice(s) [${slices.map((s) => s.id).join(', ')}]`);
          emit('plan-result', { tag, status: 'queued', queued: slices.length, ids: slices.map((s) => s.id) });
          emitStats();
        } else if (switched) {
          console.log(`Planner ${tag}: ${switched.demoted.join(', ')} unavailable — will retry with ${auto.describe()}.`);
          emit('plan-result', { tag, status: 'provider-switch', queued: 0, ids: [], demoted: switched.demoted });
          emitStats();
        } else {
          noteNoWork(empty ? 'nothing actionable' : 'no valid plan');
        }
      } catch (e) {
        noteNoWork(`planner errored: ${e.message}`);
      } finally {
        planningPromise = null;
      }
    })();
    return planningPromise;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Fix lane has work (or might, until a scan confirms otherwise).
  const fixAlive = () => fixCap > 0 && (fixInFlight.size > 0 || fixReady.length > 0 || !fixDry);

  // Reserve fixCap slots for the fix lane while it has work, so builds can't starve it.
  function launchReady() {
    const maxBuild = K - (fixCap > 0 && !fixDry ? fixCap : 0);
    while (inFlight.size < maxBuild && active.size < K && ready.length > 0 && launchedCount < sliceBudget) {
      const slice = ready.shift();
      const slotId = freeSlotId();
      launchedCount += 1;
      if (slice.kind === 'refactor') launchedSinceRefactor = 0;
      else launchedSinceRefactor += 1;
      inFlight.set(slotId, { slice, startedAt: Date.now() });
      const idx = String(launchedCount).padStart(3, '0');
      const sliceDir = join(runDir, 'slices', `${idx}-${slice.id}`.slice(0, 120));
      console.log(`[w${slotId}] launch ${launchedCount}/${sliceBudget}: [${slice.repo}] ${slice.kind === 'refactor' ? 'REFACTOR ' : ''}${slice.id} — ${slice.title}`);
      emit('launch', { slot: slotId, sliceId: slice.id, repo: slice.repo, title: slice.title, kind: slice.kind, index: launchedCount, budget: sliceBudget });
      emitStats();
      const p = runWorkerFn({ slotId, slice }, sliceDir, args)
        .then((result) => ({ slotId, result }))
        .catch((err) => ({ slotId, result: { slotId, slice, ok: false, reason: `worker crashed: ${err.message}` } }));
      active.set(slotId, p);
    }
  }

  // Rescan GitHub for fixable worker PRs (throttled unless forced), queueing any
  // not already in flight, queued, or attempt-exhausted. Sets fixDry when there's
  // nothing actionable left so the pool can finish.
  function scanFixables(force) {
    if (fixCap === 0) return;
    if (ghCooling()) return; // rate-limited: don't scan, and don't let fixDry flip (we just don't know yet)
    if (!force && Date.now() - lastFixScan < FIX_SCAN_INTERVAL_MS) return;
    lastFixScan = Date.now();
    // Branches being actively built right now — their PRs are legitimately draft,
    // so the stale-draft rule must not send them to the fix lane mid-build.
    const activeBranches = new Set([...inFlight.entries()].map(([slotId, x]) => `worker-${slotId}/${x.slice.id}`));
    let found;
    try { found = findFixablePrsFn(repos, activeBranches); } catch (e) { console.warn(`Fix scan failed: ${e.message}`); return; }
    const busy = new Set([...[...fixInFlight.values()].map(prKey), ...fixReady.map(prKey)]);
    const fresh = found.filter((it) => !busy.has(prKey(it)) && (fixAttempts.get(prKey(it)) || 0) < MAX_FIX_ATTEMPTS);
    fixReady.push(...fresh);
    fixDry = fixReady.length === 0 && fixInFlight.size === 0;
    if (fresh.length) console.log(`Fix scan: +${fresh.length} fixable PR(s) (${fixReady.length} queued, ${fixInFlight.size} fixing).`);
    emit('fix-scan', { found: found.length, queued: fixReady.length, fixing: fixInFlight.size });
  }

  function launchFixes() {
    while (fixCap > 0 && fixInFlight.size < fixCap && fixReady.length > 0 && active.size < K) {
      const item = fixReady.shift();
      const key = prKey(item);
      if ([...fixInFlight.values()].some((it) => prKey(it) === key)) continue; // already fixing this PR
      const attempt = (fixAttempts.get(key) || 0) + 1;
      if (attempt > MAX_FIX_ATTEMPTS) continue;
      fixAttempts.set(key, attempt);
      const slotId = freeSlotId();
      fixInFlight.set(slotId, item);
      const fixDir = join(runDir, 'fixes', `${item.repo.split('/').pop()}-${item.number}-try${attempt}`);
      console.log(`[fix-w${slotId}] fixing ${key} (${item.state}) — try ${attempt}/${MAX_FIX_ATTEMPTS}`);
      emit('launch', { slot: slotId, sliceId: `fix #${item.number}`, repo: item.repo, title: `fix ${item.state} PR #${item.number}`, kind: 'fix', prNumber: item.number });
      emitStats();
      const p = runFixWorkerFn(item, fixDir, slotId, args)
        .then((result) => ({ slotId, result, fix: true }))
        .catch((err) => ({ slotId, result: { ...item, ok: false, reason: `fix crashed: ${err.message}` }, fix: true }));
      active.set(slotId, p);
    }
  }

  function maybeStartReconcile() {
    if (reconcileEverySlices === 0 || reconciling) return;
    if (mergedSliceCount - reconciledAtMerge < reconcileEverySlices) return;
    if (plansBusy()) return; // a slice is building/queued in the repo that holds the plans
    reconciling = true;
    reconciledAtMerge = mergedSliceCount;
    const idx = pendingReconciles.length + 1;
    const snapshot = [...mergedPrs];
    console.log(`\n== Mid-run plan reconcile #${idx} (after ${mergedSliceCount} merged slice(s)) ==`);
    emit('reconcile-start', { idx, label: `mid-run #${idx}`, atMergedSlices: mergedSliceCount });
    const p = reconcileFn({ repos, mergedPrs: snapshot, roles, passLabel: `mid-run #${idx}`, logPath: join(runDir, `reconcile-mid-${idx}.log`), workspace: args.workspace, plansPath })
      .catch((e) => console.error(`Mid-run reconcile #${idx} failed (non-fatal): ${e.message}`))
      .finally(() => { reconciling = false; emit('reconcile-finish', { idx }); });
    pendingReconciles.push(p);
  }

  // Seed slices: hand-authored work the planner won't surface on its own (e.g. minor
  // CI/test-harness gaps it ranks below "high-value feature" work). They go straight
  // into `ready` so the pool builds them through the normal worker/review/merge lanes;
  // the planner then tops up around them (they're already in `ready`, so it excludes
  // them and never double-builds). Validated exactly like a planner batch.
  if (args.seedSlices) {
    let seeded;
    try {
      seeded = JSON.parse(readFileSync(args.seedSlices, 'utf8'));
    } catch (e) {
      throw new Error(`--seed-slices: could not read/parse ${args.seedSlices}: ${e.message}`);
    }
    const { ok, slices, problems } = validateSlices(seeded, Array.isArray(seeded) ? seeded.length : 0, repos, []);
    if (!ok) throw new Error(`--seed-slices: invalid seed file: ${problems.join('; ')}`);
    ready.push(...slices);
    console.log(`Seeded ${slices.length} slice(s) from ${args.seedSlices}: [${slices.map((s) => s.id).join(', ')}]`);
    emit('seed-slices', { count: slices.length, ids: slices.map((s) => s.id) });
  }

  // 0. Drain any review-clean worker PRs left from an interrupted earlier run.
  console.log('\n######## Pool start: drain leftover worker PRs ########');
  const drainedAtStart = mergeFn(repos, 'Drain (start)', join(runDir, 'drain-start'));
  if (drainedAtStart.length) {
    mergedPrs.push(...drainedAtStart);
    emit('merge', { label: 'drain-start', merged: drainedAtStart, total: [...new Set(mergedPrs)].length });
  }

  const PLAN_TICK = Symbol('plan-done');
  while (active.size > 0 || ready.length > 0 || (!dry && launchedCount < sliceBudget) || fixAlive()) {
    maybeResyncProviders(); // re-select if a cooled-down provider recovered
    scanFixables(false); // throttled GitHub rescan -> fixReady
    launchFixes();       // dispatch fix-workers up to fixCap
    launchReady();       // dispatch build-workers (capped to leave fix slots free)

    // Keep the build buffer warm in the background while builds/fixes run.
    if (!dry && active.size + ready.length < K && launchedCount + ready.length < sliceBudget) {
      void pump();
    }

    // Nothing running and nothing queued: make progress on fixes/plans or finish.
    if (active.size === 0 && ready.length === 0) {
      if (fixCap > 0 && fixReady.length === 0 && !fixDry) { scanFixables(true); launchFixes(); }
      if (active.size > 0) continue;
      if (!dry && launchedCount < sliceBudget) {
        if (planningPromise) { await planningPromise; continue; }
        await pump();
        continue;
      }
      if (fixAlive()) { await sleep(2000); continue; } // builds done; let fixes settle/re-scan
      break; // build dry AND fix dry
    }

    // Wake on the FIRST of: a worker finishing, or a background plan completing.
    const waiters = [...active.values()];
    if (planningPromise) waiters.push(planningPromise.then(() => PLAN_TICK));
    const settled = await Promise.race(waiters);
    if (settled === PLAN_TICK) continue;

    const { slotId, result } = settled;
    active.delete(slotId);

    // ---- a fix-worker finished ----
    if (fixInFlight.has(slotId)) {
      const item = fixInFlight.get(slotId);
      fixInFlight.delete(slotId);
      console.log(`[fix-w${slotId}] ${prKey(item)} exited ${result.ok ? 'ok' : 'with error'}`);
      reactToWorkerLog(result); // demote a provider that hit a limit
      emit('worker-done', { slot: slotId, sliceId: `fix #${item.number}`, ok: !!result.ok, branch: item.branch || null, repo: item.repo, kind: 'fix', reason: result.reason });
      emitStats();
      // The fix pushed and CI re-runs; merge anything in this repo that is now clean.
      const merged = mergeFn([item.repo], `Merge after fix ${prKey(item)}`, join(runDir, 'fix-merges', String(item.number)));
      if (merged.length) {
        mergedPrs.push(...merged);
        mergedSliceCount += merged.length;
        fixedCount += merged.length;
        emit('merge', { label: `after fix ${prKey(item)}`, merged, repo: item.repo, total: [...new Set(mergedPrs)].length });
        emitStats();
      }
      maybeStartReconcile();
      continue;
    }

    // ---- a build-worker finished ----
    const entry = inFlight.get(slotId) || {};
    const slice = entry.slice || result.slice;
    const buildMs = entry.startedAt ? Date.now() - entry.startedAt : null;
    inFlight.delete(slotId);
    if (!result.ok) {
      failedCount += 1;
      console.warn(`[w${slotId}] slice "${slice?.id}" did not finish cleanly${result.reason ? `: ${result.reason}` : ''}`);
    }
    reactToWorkerLog(result); // demote a provider that hit a limit
    emit('worker-done', { slot: slotId, sliceId: slice?.id, ok: !!result.ok, branch: result.branch || null, repo: slice?.repo, kind: slice?.kind, ms: buildMs, reason: result.reason });
    emitStats();

    // Merge this finisher's PR(s) in its own repo (serial, synchronous). Landing it
    // refreshes the default branch so the next planner call sees the new baseline.
    const merged = mergeFn([slice.repo], `Merge after ${slice?.id}`, join(runDir, 'merges', String(launchedCount).padStart(3, '0')));
    if (merged.length) {
      mergedPrs.push(...merged);
      mergedSliceCount += merged.length;
      emit('merge', { label: `after ${slice?.id}`, merged, repo: slice.repo, total: [...new Set(mergedPrs)].length });
      emitStats();
    }
    maybeStartReconcile();
  }

  // Let any concurrent mid-run reconcile settle before the final passes.
  if (pendingReconciles.length) await Promise.allSettled(pendingReconciles);

  // Final drain across ALL repos for PRs that were deferred or auto-merge-queued.
  console.log('\n######## Final drain ########');
  const finalMerged = mergeFn(repos, 'Drain (final)', join(runDir, 'drain-final'));
  // Every slot is idle now: drop the pool's worktrees so the branches they pin
  // become deletable, then run one last hygiene pass. (No-op for repos that don't
  // exist locally, so mocked-deps test runs are unaffected.)
  agentBranchCleanup(repos, 'Final branch hygiene', join(runDir, 'drain-final'), { removeWorktrees: true, workspace: args.workspace });
  if (finalMerged.length) {
    mergedPrs.push(...finalMerged);
    emit('merge', { label: 'drain-final', merged: finalMerged, total: [...new Set(mergedPrs)].length });
  }
  emitStats();

  // Guaranteed end-of-run plan reconcile so the build plans finish consistent
  // with what merged.
  if (args.reconcile) {
    console.log('\n######## Final plan reconcile ########');
    emit('reconcile-start', { idx: pendingReconciles.length + 1, label: 'end of run' });
    try {
      await reconcileFn({ repos, mergedPrs, roles, passLabel: 'end of run', logPath: join(runDir, 'reconcile-final.log'), workspace: args.workspace, plansPath });
    } catch (e) {
      console.error(`Final reconcile failed (non-fatal): ${e.message}`);
    }
    emit('reconcile-finish', { idx: pendingReconciles.length + 1 });
  }

  const mergedTotal = [...new Set(mergedPrs)].length;
  const exhausted = [...fixAttempts.entries()].filter(([, n]) => n >= MAX_FIX_ATTEMPTS).map(([k]) => k);
  console.log(`\nDone. ${launchedCount} slice(s) attempted, ${mergedTotal} PR(s) merged${fixCap > 0 ? `, ${fixedCount} fixed PR(s) landed` : ''}. Transcripts: ${runDir}`);
  if (exhausted.length) console.warn(`Fix lane gave up on ${exhausted.length} PR(s) after ${MAX_FIX_ATTEMPTS} tries: ${exhausted.join(', ')}`);
  emit('run-done', { launched: launchedCount, mergedPrs: mergedTotal, failed: failedCount, fixed: fixedCount, fixUnresolved: exhausted.length, elapsedMs: Date.now() - startedAt });
}

// ---------------------------------------------------------------------------
// Entry: load config, select providers, then hand off to the pool driver
// (or plan-only / dry-run).
// ---------------------------------------------------------------------------

function buildRunArgs(config, overrides) {
  return {
    workspace: config.workspace,
    repos: [...config.repos],
    plansDir: config.plansDir,
    plansPath: config.plansPath,
    preferencesPath: config.preferencesPath,
    preferences: null, // loaded in runOrchestrator
    workers: overrides.workers ?? config.workers,
    fixWorkers: overrides.fixWorkers ?? config.fixWorkers,
    maxSlices: overrides.maxSlices ?? config.maxSlices,
    seedSlices: overrides.seedSlices ?? null,
    builder: overrides.builder ?? null,
    reviewer: overrides.reviewer ?? null,
    refactorEvery: overrides.refactorEvery ?? defaultRefactorEvery(),
    reconcileEvery: overrides.reconcileEvery ?? 0,
    reconcile: overrides.reconcile ?? true,
    depsLink: overrides.depsLink ?? true,
    planOnly: !!overrides.planOnly,
    dryRun: !!overrides.dryRun,
  };
}

// Run the orchestrator against a loaded config. `overrides` accepts the same
// fields as the CLI flags (workers, maxSlices, fixWorkers, seedSlices, dryRun,
// planOnly, builder, reviewer, refactorEvery, reconcileEvery, reconcile,
// depsLink). This is what `planforge run` calls.
export async function runOrchestrator(config, overrides = {}) {
  const args = buildRunArgs(config, overrides);
  if (!Number.isInteger(args.workers) || args.workers < 1) throw new Error('workers must be a positive integer');
  if (!Number.isInteger(args.maxSlices) || args.maxSlices < 1) throw new Error('maxSlices must be a positive integer');
  if (!Number.isInteger(args.fixWorkers) || args.fixWorkers < 0) throw new Error('fixWorkers must be a non-negative integer');
  if (args.repos.length === 0) {
    throw new Error(`No repos in scope — add them to "repos" in ${config.configPath}.`);
  }
  if (!existsSync(args.workspace)) throw new Error(`Workspace does not exist: ${args.workspace}`);
  const sliceBudget = args.maxSlices;
  const runDir = join(args.workspace, '.planforge', 'runs', timestamp());

  // Models: the agent scripts read these env vars; config is the source of truth.
  applyModelEnv(config.models);

  // Providers. Automatic priority selection with reactive failover is the
  // DEFAULT; --builder/--reviewer pin the pair and disable failover.
  const dualRoleAllowed = config.providers.dualRoleAllowed;
  let auto = null;
  let roles;
  if (args.builder || args.reviewer) {
    const builder = args.builder || config.providers.builderPriority[0];
    const reviewer =
      args.reviewer ||
      config.providers.reviewerPriority.find((p) => p !== builder || dualRoleAllowed.includes(p)) ||
      config.providers.reviewerPriority[0] ||
      builder;
    for (const p of new Set([builder, reviewer])) {
      if (!providerHasAgent(p)) {
        throw new Error(`Provider "${p}" has no agent script at ${agentScriptFor(p)}.`);
      }
    }
    setRoleSlots(builder, reviewer);
    roles = { builder: providerLabel(builder), reviewer: providerLabel(reviewer) };
    if (isForcedSameProvider({ builder, reviewer }, dualRoleAllowed)) {
      console.warn(`Pinned providers use ${providerLabel(builder)} for BOTH roles (policy prefers distinct providers unless dual-role-allowed).`);
    }
    console.log(`Pinned providers (no failover) -> ${roles.builder} build / ${roles.reviewer} review`);
  } else {
    auto = createAutoProvider({ providers: config.providers });
    const picked = auto.sync();
    if (!picked.builder) {
      throw new Error(
        `No provider available. Configured priorities: builder [${config.providers.builderPriority.join(', ')}], reviewer [${config.providers.reviewerPriority.join(', ')}] — ensure the agent scripts exist in core/agents/.`
      );
    }
    roles = { builder: providerLabel(picked.builder), reviewer: providerLabel(picked.reviewer) };
    if (isForcedSameProvider(picked, dualRoleAllowed)) {
      console.warn(`Only ${roles.builder} is available — using it for BOTH roles (policy prefers distinct providers unless dual-role-allowed).`);
    }
    console.log(`Automatic provider selection (reactive failover) -> ${auto.describe()}`);
    console.log(`  builder: ${config.providers.builderPriority.join('>')} · reviewer: ${config.providers.reviewerPriority.join('>')} · distinct providers unless dual-role-allowed (${dualRoleAllowed.join(', ') || 'none'})\n`);
  }

  // Stack preferences (optional): injected into the planner prompt.
  if (existsSync(args.preferencesPath)) {
    try {
      args.preferences = JSON.parse(readFileSync(args.preferencesPath, 'utf8'));
    } catch (e) {
      console.warn(`Could not parse ${args.preferencesPath} (${e.message}) — continuing without preferences.`);
    }
  }

  console.log(`Orchestrator (continuous pool): up to ${args.workers} worker(s) in parallel · ${sliceBudget} slice budget`);
  console.log(`Workspace: ${args.workspace}`);
  console.log(`Repos: ${args.repos.join(', ')}`);
  console.log(`Plans: ${args.plansPath}`);
  console.log(`Run dir: ${runDir}`);
  console.log(
    `Cost note: each worker is a full ${roles.builder === roles.reviewer ? roles.builder : `${roles.builder}+${roles.reviewer}`} chain — this is ~${args.workers}x the API spend of one serial chain.`
  );
  console.log(
    `Refactor lane: ${args.refactorEvery >= 1 ? `~one refactor slice per ${args.refactorEvery * args.workers} launched slices` : 'off'} · Reconcile: ${args.reconcile ? (args.reconcileEvery >= 1 ? `~every ${args.reconcileEvery * args.workers} merged slices + end-of-run` : 'end-of-run') : 'off'}`
  );
  console.log(
    `Fix lane: ${args.fixWorkers >= 1 ? `up to ${args.fixWorkers} worker(s) fixing deferred failing/conflicting PRs (auto-merge when green)` : 'off'}\n`
  );

  if (args.dryRun) {
    console.log('DRY RUN — no agents spawned, no git/gh writes.\n');
    console.log(`Planner/reconcile command (${roles.builder}):\n  ${builderAgentCommand(args.workspace).command}\n`);
    console.log(`Continuous pool: keep ${args.workers} worker(s) busy until ${sliceBudget} slice(s) attempted (or the planner goes dry ${MAX_EMPTY_PLANS}x).`);
    console.log(`- A serialized planner surveys ${args.plansPath}/*-build-plan.md and tops up a buffer with up to (free slots) slices per call, each disjoint from everything in flight/queued.`);
    if (args.refactorEvery >= 1) console.log(`- Forces one behavior-preserving refactor slice ~every ${args.refactorEvery * args.workers} launched slices (never two at once).`);
    console.log('- Each freed worker is refilled immediately; planning, building, and merging overlap (no per-round barrier).');
    console.log('');
    for (let k = 1; k <= args.workers; k += 1) {
      console.log(`Worker slot ${k} runs (per assigned slice):`);
      console.log(
        `  node ${CHAIN} --workspace <.planforge/worktrees/worker-${k}> --slice-file <slice.json> --pr-scope worker-${k} --defer-merge --no-discover-open-prs --no-reconcile --no-cleanup --loops 1 --allow-repo <repo>`
      );
    }
    console.log("\nAs each worker finishes: serial mergeCleanOpenPrs over that repo's open agent-branch PRs (drafts are never force-readied), then refill from the buffer.");
    if (args.fixWorkers >= 1) {
      console.log(`Fix lane: up to ${args.fixWorkers} worker(s) reserved to fix deferred failing/conflicting/stale-draft worker PRs in parallel with builds, e.g.`);
      console.log(`  node ${CHAIN} --workspace <worktree> --prs <PR#> --no-discover-open-prs --defer-merge --no-reconcile --no-cleanup --loops 1 --allow-repo <repo>`);
      console.log(`  Rescans every ${FIX_SCAN_INTERVAL_MS / 1000}s; up to ${MAX_FIX_ATTEMPTS} tries per PR; auto-merges when green. The run only ends once builds AND fixes are dry.`);
    }
    if (args.reconcile) console.log(`Reconcile: ${args.reconcileEvery >= 1 ? `concurrent pass ~every ${args.reconcileEvery * args.workers} merged slices + ` : ''}guaranteed end-of-run pass updating the plan docs in ${args.plansPath}.`);
    return; // dry-run writes nothing — no run dir created
  }

  // Real run (or --plan-only): now create the run dir we'll write logs/events into.
  mkdirSync(runDir, { recursive: true });

  if (!commandExists('gh')) throw new Error('gh CLI is required for PR discovery/merge.');

  if (args.planOnly) {
    console.log('\n--plan-only: running ONE planner call (no workers, no merges).');
    const { slices, empty } = await planSome({
      k: args.workers,
      repos: args.repos,
      inFlight: [],
      logDir: runDir,
      logTag: 'plan-only',
      roles,
      refactorRound: args.refactorEvery === 1,
      workspace: args.workspace,
      plansPath: args.plansPath,
      preferences: args.preferences,
    });
    if (!slices.length) {
      console.log(empty ? 'Planner found nothing actionable right now.' : 'Planner failed to return a valid plan.');
      return;
    }
    console.log(`\nValidated plan (${slices.length} disjoint slice(s)):`);
    slices.forEach((s, i) => {
      console.log(`  ${i + 1}. [${s.repo}] ${s.kind === 'refactor' ? 'REFACTOR ' : ''}${s.id} — ${s.title}`);
      console.log(`     paths: ${s.paths.join(', ')}`);
    });
    console.log('\nDisjointness: OK (validated pairwise non-overlapping).');
    return;
  }

  await runPool({ args, runDir, roles, sliceBudget, emit: createEmitter(runDir), auto });
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const config = loadConfig(cli.config || process.cwd());
  await runOrchestrator(config, cli);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  });
}
