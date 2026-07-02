#!/usr/bin/env node
// PlanForge review chain: one builder-agent -> reviewer-agent -> builder-agent
// loop that lands work as merge-ready GitHub PRs. Run standalone it repeats the
// loop serially; the orchestrator (core/orchestrator.mjs) spawns it once per
// slice in a fresh worktree with --slice-file/--pr-scope/--defer-merge.
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shellInvocation, isTempPath } from './platform.mjs';

// Parent dir holding the target repo checkouts. Defaults to the current working
// directory; override with PLANFORGE_WORKSPACE. The orchestrator always passes
// --workspace <worktree>, so this default only applies when the chain is run
// standalone.
const DEFAULT_WORKSPACE = process.env.PLANFORGE_WORKSPACE
  ? resolve(process.env.PLANFORGE_WORKSPACE)
  : process.cwd();
const BUNDLED_CODEX = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_CODEX_EFFORT = 'high';
const DEFAULT_CLAUDE_MODEL = 'claude-fable-5';
// Used when DEFAULT_CLAUDE_MODEL is unavailable at runtime (e.g. access gated).
const DEFAULT_CLAUDE_FALLBACK_MODEL = 'claude-opus-4-8';
const DEFAULT_CLAUDE_EFFORT = 'high';
// In --claude-only mode the review step runs at this higher effort ("extra" high).
const CLAUDE_ONLY_REVIEW_EFFORT = 'xhigh';
const DEFAULT_LOOPS = 25;
const DEFAULT_PLANS_DIR = 'plans';

// Slice-selection instructions used when the chain picks its own work (not in
// orchestrator worker mode, where the slice is assigned). Plans live in the
// workspace's plans directory as <slug>-build-plan.md documents (format:
// planning/plan-format.md — Overview / Architecture / Open decisions / Phases /
// Status ledger).
const sliceSelectionProtocol = (plansDir) => `Slice-selection protocol — do this BEFORE writing any code, and show your work in the final summary:
1. Survey EVERY build plan, not just whatever the working tree currently sits on. List the plans directory (${plansDir}) and read every *-build-plan.md that plausibly contains actionable, unblocked work. Do not pick a slice from a single plan until you have looked across the folder.
2. Build a short candidate list (aim for the top 3-5) of the most valuable available slices. Candidates are NOT limited to plan-driven feature work — a behavior-preserving refactor that splits an oversized source file (see the large-file directive below) is a valid candidate too, especially when no higher-value feature slice exists. For each candidate note: source (plan/section or file), rough value/impact, readiness (genuinely unblocked vs. waiting on a dependency), and rough effort.
3. Rank the candidates and pick exactly one. Honor each plan's gates: a slice whose phase or status says blocked-on-Dx, where decision Dx in that plan's "## 3. Open decisions" is not Accepted, is NOT buildable; and never pull a later-phase slice before its prerequisite phases have merged. Prefer the highest value-per-effort slice that is genuinely unblocked. Continuing an in-progress thread is allowed ONLY if it still outranks the other candidates on its merits — not merely because the checkout already sits on that branch.
4. In your final summary, include a "Slice survey" section that lists the candidates you considered (with the value/readiness/effort notes) and a one-line justification for why the chosen slice outranks the others. If there is no actionable, unblocked feature slice this iteration, fall back to a large-file refactor candidate before declaring the iteration idle; only report "nothing actionable" if neither a feature slice nor an oversized-file refactor exists, and list what you surveyed.`;
const REFACTOR_LINE_THRESHOLD = Number(process.env.CHAIN_REFACTOR_THRESHOLD) || 600;
const DEFAULT_REFACTOR_EVERY = 4;
const REFACTOR_DIRECTIVE = `Large-file refactors are in-scope slices. Oversized source files hurt agent context, so splitting them into smaller, focused modules is genuine, valuable work — pick one when no higher-value feature slice is available this iteration instead of leaving the iteration idle.
- Find candidates yourself within the chain's scoped code repo(s): from each repo root, list tracked source files with line counts (e.g. \`git ls-files '*.ts' '*.tsx' '*.js' '*.jsx' | xargs wc -l | sort -nr\`) and ignore generated/vendored/build output (node_modules, dist, build, *.gen.*, lockfiles, snapshots). Treat files materially over ${REFACTOR_LINE_THRESHOLD} lines as candidates and prefer the largest / most-churned.
- Refactors MUST be behavior-preserving: no functional change and no public API/signature change (internal-only restructuring). Split by responsibility/cohesion, keep all imports and exports working, and keep the diff reviewable.
- One file (or one tight cluster) per iteration, in its OWN PR — never bundle a refactor with a feature slice, so it reviews and reverts cleanly.
- All relevant tests plus typecheck/lint MUST pass before opening the PR; the refactor lands through the same review + merge gate as any other slice.
- If a large file is genuinely cohesive and splitting would hurt clarity, skip it and note why in the Slice survey instead of forcing a split.`;
// When `slice` is set (a parallel worker scoped to one assigned slice), the
// builder must NOT survey for or switch to a different slice, so the
// slice-selection protocol and the refactor-picking directive are dropped.
const builderBasePrompt = (roles, slice, plansDir) =>
  slice
    ? `work ONLY on your assigned slice (described above) and merge it when ready — do NOT survey for, pick, or switch to any other slice. In this automation, "after review" means after ${roles.reviewer} has posted its review comment in this chain and ${roles.builder} has handled every actionable item; there is no separate human-review gate. Any out-of-scope gaps you notice should be noted in the relevant plan document, not fixed in this slice.`
    : `merge when ready, and find the next most valuable slice or thing to do from the build plans in ${plansDir}. In this automation, "after review" means after ${roles.reviewer} has posted its review comment in this chain and ${roles.builder} has handled every actionable item; there is no separate human-review gate. Any gaps found along the way should be recorded in the relevant plan document to be picked up when it makes the most sense.

${sliceSelectionProtocol(plansDir)}

${REFACTOR_DIRECTIVE}`;
const MAX_CONTEXT_CHARS = 18000;

// Reconciliation step: after merges land, the build-plan documents (slice
// statuses + status ledgers) drift from reality. This step brings them back in
// line so the plans stay the single source of truth. 0 = only the guaranteed
// end-of-run pass.
const DEFAULT_RECONCILE_EVERY = 0;

function usage() {
  const script = fileURLToPath(import.meta.url);
  console.log(`Usage:
  node ${script} [options]

Runs:
  Repeats this sequence ${DEFAULT_LOOPS} times by default:
  1. Builder agent: find/continue the next most valuable slice.
  2. Reviewer agent: dynamically reviews PRs/results and posts PR comments.
  3. Builder agent: checks comments, makes changes, replies/resolves, and continues.

Options:
  --workspace <dir>       Working directory for both agents.
  --log-dir <dir>         Directory for transcripts. Default: <workspace>/.planforge/runs/<timestamp>
  --plans-dir <dir>       Directory holding the *-build-plan.md documents (relative
                          to the workspace unless absolute). Default: ${DEFAULT_PLANS_DIR}
  --prs <list>            Comma/newline/space separated PR URLs or repo#number values to seed [PRs].
  --repo <owner/repo>     Discover and process every open PR in this repo. Repeatable.
  --allow-repo <pattern>  Restrict tracked PRs to matching repos; ignore all others
                          (even if agents mention them). Pattern: owner/repo, owner/*,
                          or owner. Repeatable. Default: the repos from --repo/--prs.
  --no-discover-open-prs  Only use PRs passed with --prs or discovered by agents.
  --no-cleanup            Skip the per-iteration local housekeeping that removes the
                          agents' temp worktrees and merged (gone-upstream) branches.
  --loops <count>         Number of builder -> reviewer -> builder cycles. Default: ${DEFAULT_LOOPS}
  --refactor-every <N>    Force a large-file refactor on every Nth iteration (0 = never
                          force; refactors still compete opportunistically). Default: ${DEFAULT_REFACTOR_EVERY}
  --reconcile-every <N>   Reconcile the build-plan documents (slice statuses +
                          status-ledger rows) on every Nth iteration so the plans
                          stay consistent with what merged. A reconcile pass always
                          runs once at the end of the whole run. 0 = end-of-run
                          pass only. Default: ${DEFAULT_RECONCILE_EVERY}
  --no-reconcile          Disable the plan reconciliation step entirely (including the
                          end-of-run pass).
  --slice-file <path>     Parallel-worker mode: a JSON file describing the single
                          assigned slice ({id, repo, title, paths, rationale, notes}).
                          The builder works ONLY on this slice and skips the
                          slice-selection survey. Set by the orchestrator.
  --slice <json>          Same as --slice-file but the slice JSON is passed inline.
  --pr-scope <prefix>     Name the worker's branch "<prefix>/<slice-id>" and keep the
                          worker on its own PR. Pair with --no-discover-open-prs so it
                          never touches other workers' PRs.
  --defer-merge           Build + review + address review + mark the PR ready, but do
                          NOT merge — leave merging to the orchestrator's serial lane.
  --claude-only           Run every step (build, review, merge) with the claude agent
                          instead of the codex agent. Use when codex is unavailable.
                          The codex CLI is not required on PATH in this mode. The
                          review step runs at --effort ${CLAUDE_ONLY_REVIEW_EFFORT} (build/merge stay at the
                          normal claude effort).
  --swap-roles            Swap the agents' roles: claude builds/merges (steps 1 and 3)
                          and codex reviews (step 2). Default is codex builds, claude
                          reviews. Not compatible with --claude-only.
  --dry-run               Print resolved prompts and commands without running agents.
  --help                  Show this help.

Environment:
  CODEX_CHAIN_MODEL       Codex model. Default: ${DEFAULT_CODEX_MODEL}
  CODEX_CHAIN_EFFORT      Codex reasoning effort. Default: ${DEFAULT_CODEX_EFFORT}
  CODEX_CHAIN_CMD         Shell command used for the builder slot. Prompt is piped on stdin.
                          Default: codex exec --model "$CODEX_CHAIN_MODEL" -c model_reasoning_effort="$CODEX_CHAIN_EFFORT" --cd "{workspace}" --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -
  CLAUDE_CHAIN_MODEL      Claude model. Default: ${DEFAULT_CLAUDE_MODEL}
  CLAUDE_CHAIN_FALLBACK_MODEL  Model used when CLAUDE_CHAIN_MODEL is unavailable at run
                          time (default claude command only). Default: ${DEFAULT_CLAUDE_FALLBACK_MODEL}
  CLAUDE_CHAIN_EFFORT     Claude effort. Default: ${DEFAULT_CLAUDE_EFFORT}
  CLAUDE_CHAIN_CMD        Shell command used for the reviewer slot. Prompt is appended as the final shell argument.
                          Default: claude -p --model "$CLAUDE_CHAIN_MODEL" --effort "$CLAUDE_CHAIN_EFFORT" --output-format stream-json --verbose --dangerously-skip-permissions, or npx fallback if claude is not on PATH. The chain renders the stream-json events as live progress lines.
  CLAUDE_CHAIN_STDIN=1    Pipe the reviewer-slot prompt on stdin instead of appending it as an argument.
  CHAIN_BUILDER_LABEL     Display name for the builder agent in prompts (set by the
                          orchestrator when a different provider fills the slot).
  CHAIN_REVIEWER_LABEL    Display name for the reviewer agent in prompts.
  CHAIN_ALLOW_REPOS       Default repo allow-list (comma/space separated owner/repo,
                          owner/*, or owner patterns). Overridden by --allow-repo.
  CHAIN_REFACTOR_THRESHOLD  Line count above which a source file becomes a large-file
                          refactor candidate for the build step. Default: ${REFACTOR_LINE_THRESHOLD}
  CHAIN_REFACTOR_EVERY    Default for --refactor-every (forced-refactor cadence; 0 disables).
                          Default: ${DEFAULT_REFACTOR_EVERY}
  CHAIN_RECONCILE_EVERY   Default for --reconcile-every (mid-run plan-reconcile cadence;
                          0 = end-of-run pass only). Default: ${DEFAULT_RECONCILE_EVERY}

Examples:
  node ${script}
  node ${script} --claude-only
  node ${script} --swap-roles
  node ${script} --loops 1
  node ${script} --repo acme/app
  node ${script} --prs https://github.com/acme/app/pull/12
  CLAUDE_CHAIN_CMD="/path/to/claude -p --dangerously-skip-permissions" node ${script}
`);
}

function parseArgs(argv) {
  const args = {
    workspace: DEFAULT_WORKSPACE,
    logDir: '',
    plansDir: DEFAULT_PLANS_DIR,
    prSeed: '',
    repos: [],
    discoverOpenPrs: true,
    loops: DEFAULT_LOOPS,
    dryRun: false,
    claudeOnly: false,
    swapRoles: false,
    refactorEvery: defaultRefactorEvery(),
    reconcileEvery: defaultReconcileEvery(),
    reconcile: true,
    cleanup: true,
    allowRepos: parseAllowReposEnv(),
    // Parallel-worker scoping (set by the orchestrator; unset = normal serial chain).
    sliceFile: '',
    sliceJson: '',
    slice: null,
    prScope: '',
    deferMerge: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--claude-only') {
      args.claudeOnly = true;
      continue;
    }
    if (arg === '--swap-roles') {
      args.swapRoles = true;
      continue;
    }
    if (arg === '--workspace') {
      args.workspace = mustReadValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--log-dir') {
      args.logDir = mustReadValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--plans-dir') {
      args.plansDir = mustReadValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--prs') {
      args.prSeed = mustReadValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--allow-repo') {
      args.allowRepos.push(mustReadValue(argv, ++i, arg));
      continue;
    }
    if (arg === '--repo') {
      args.repos.push(mustReadValue(argv, ++i, arg));
      continue;
    }
    if (arg === '--no-discover-open-prs') {
      args.discoverOpenPrs = false;
      continue;
    }
    if (arg === '--no-cleanup') {
      args.cleanup = false;
      continue;
    }
    if (arg === '--loops') {
      args.loops = parsePositiveInt(mustReadValue(argv, ++i, arg), arg);
      continue;
    }
    if (arg === '--refactor-every') {
      args.refactorEvery = parseNonNegativeInt(mustReadValue(argv, ++i, arg), arg);
      continue;
    }
    if (arg === '--reconcile-every') {
      args.reconcileEvery = parseNonNegativeInt(mustReadValue(argv, ++i, arg), arg);
      continue;
    }
    if (arg === '--no-reconcile') {
      args.reconcile = false;
      continue;
    }
    if (arg === '--slice-file') {
      args.sliceFile = mustReadValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--slice') {
      args.sliceJson = mustReadValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--pr-scope') {
      args.prScope = mustReadValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--defer-merge') {
      args.deferMerge = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (args.swapRoles && args.claudeOnly) {
    throw new Error('--swap-roles cannot be combined with --claude-only.');
  }

  // Resolve the assigned slice (parallel-worker mode). --slice-file wins over
  // --slice; both carry the same {id, repo, title, paths, rationale, notes} shape.
  if (args.sliceFile || args.sliceJson) {
    const rawSlice = args.sliceFile
      ? readFileSync(isAbsolute(args.sliceFile) ? args.sliceFile : resolve(args.workspace, args.sliceFile), 'utf8')
      : args.sliceJson;
    try {
      args.slice = JSON.parse(rawSlice);
    } catch (error) {
      throw new Error(`Could not parse ${args.sliceFile ? `--slice-file ${args.sliceFile}` : '--slice'} as JSON: ${error.message}`);
    }
    if (!args.slice || typeof args.slice !== 'object' || !args.slice.id) {
      throw new Error('The assigned slice must be a JSON object with at least an "id" field.');
    }
  }

  args.workspace = resolve(args.workspace);
  if (!args.logDir) {
    args.logDir = join(args.workspace, '.planforge', 'runs', timestamp());
  } else {
    args.logDir = isAbsolute(args.logDir) ? args.logDir : resolve(args.workspace, args.logDir);
  }
  args.plansPath = isAbsolute(args.plansDir) ? args.plansDir : resolve(args.workspace, args.plansDir);

  return args;
}

function mustReadValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== String(value).trim()) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== String(value).trim()) {
    throw new Error(`${flag} must be a non-negative integer (0 disables)`);
  }
  return parsed;
}

// Forced-refactor cadence default: CHAIN_REFACTOR_EVERY env if a valid non-negative
// integer, else DEFAULT_REFACTOR_EVERY. A --refactor-every flag overrides this.
function defaultRefactorEvery() {
  const raw = process.env.CHAIN_REFACTOR_EVERY;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REFACTOR_EVERY;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && String(parsed) === raw.trim()
    ? parsed
    : DEFAULT_REFACTOR_EVERY;
}

// Mid-run plan-reconcile cadence default: CHAIN_RECONCILE_EVERY env if a valid
// non-negative integer, else DEFAULT_RECONCILE_EVERY. A --reconcile-every flag
// overrides this. 0 means "only the guaranteed end-of-run pass".
function defaultReconcileEvery() {
  const raw = process.env.CHAIN_RECONCILE_EVERY;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RECONCILE_EVERY;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && String(parsed) === raw.trim()
    ? parsed
    : DEFAULT_RECONCILE_EVERY;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function expandTemplate(template, vars) {
  return template.replace(/\{workspace\}/g, vars.workspace).replace(/\{logDir\}/g, vars.logDir);
}

function defaultCodexCommand(workspace) {
  const codex = existsSync(BUNDLED_CODEX) ? BUNDLED_CODEX : 'codex';
  const model = process.env.CODEX_CHAIN_MODEL || DEFAULT_CODEX_MODEL;
  const effort = process.env.CODEX_CHAIN_EFFORT || DEFAULT_CODEX_EFFORT;
  return `${shellQuote(codex)} exec --model ${shellQuote(model)} -c ${shellQuote(`model_reasoning_effort="${effort}"`)} --cd ${shellQuote(workspace)} --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -`;
}

function defaultClaudeCommand(effortOverride) {
  const model = process.env.CLAUDE_CHAIN_MODEL || DEFAULT_CLAUDE_MODEL;
  const effort = effortOverride || process.env.CLAUDE_CHAIN_EFFORT || DEFAULT_CLAUDE_EFFORT;
  // stream-json (which requires --verbose) emits events as the agent works, so
  // the chain can show live progress instead of staying silent until the step ends.
  const claudeArgs = `-p --model ${shellQuote(model)} --effort ${shellQuote(effort)} --output-format stream-json --verbose --dangerously-skip-permissions`;
  if (commandExists('claude')) {
    return `claude ${claudeArgs}`;
  }
  return `npx -y @anthropic-ai/claude-code@latest ${claudeArgs}`;
}

function commandExists(command) {
  // Through the POSIX shell (Git Bash on Windows) so PATH semantics match how
  // the composed commands will actually run.
  let inv;
  try {
    inv = shellInvocation(`command -v ${shellQuote(command)}`, { login: true });
  } catch {
    return false;
  }
  const result = spawnSync(inv[0], inv[1], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function firstCommandName(shellCommand) {
  const trimmed = shellCommand.trim();
  const match = trimmed.match(/^('([^']+)'|"([^"]+)"|[^\s]+)/);
  if (!match) return '';
  return match[2] || match[3] || match[1];
}

function preflightCommand(label, shellCommand, customEnvName) {
  const first = firstCommandName(shellCommand);
  if (!first || first.includes('=') || first.includes('/')) return;
  if (!commandExists(first)) {
    throw new Error(
      `${label} command '${first}' was not found on PATH. Install it or set ${customEnvName}.`
    );
  }
}

function normalizePrs(text) {
  const found = new Set();
  const add = (value) => {
    const cleaned = value.trim().replace(/[),.;\]]+$/g, '');
    if (cleaned) found.add(cleaned);
  };

  for (const match of text.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\b[\w.-]+\/[\w.-]+#\d+\b/g)) {
    add(match[0]);
  }
  for (const chunk of text.split(/[\s,]+/)) {
    if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(chunk)) {
      add(chunk);
    } else if (/^[\w.-]+\/[\w.-]+#\d+$/.test(chunk)) {
      add(chunk);
    }
  }

  return [...found];
}

function parsePrRef(ref) {
  let match = ref.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/);
  if (match) {
    return { repo: `${match[1]}/${match[2]}`, number: match[3], ref };
  }
  match = ref.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (match) {
    return { repo: match[1], number: match[2], ref };
  }
  return null;
}

function canonicalPrRef(ref) {
  const parsed = parsePrRef(ref);
  return parsed ? `${parsed.repo}#${parsed.number}` : ref;
}

function uniqueCanonicalPrs(prs) {
  const found = new Map();
  for (const pr of prs) {
    const parsed = parsePrRef(pr);
    if (!parsed) continue;
    const key = `${parsed.repo}#${parsed.number}`;
    if (!found.has(key)) found.set(key, key);
  }
  return [...found.values()];
}

function addUnique(items, value) {
  if (value && !items.includes(value)) items.push(value);
}

function reposFromPrs(prs) {
  const repos = [];
  for (const pr of prs) {
    const parsed = parsePrRef(pr);
    if (parsed) addUnique(repos, parsed.repo);
  }
  return repos;
}

// Allow-list match for an `owner/repo`. Patterns: exact `owner/repo`, whole-org
// `owner/*` or bare `owner`. An empty allow-list means "allow everything".
function repoAllowed(repo, allowList) {
  if (!allowList || allowList.length === 0) return true;
  if (!repo) return false;
  const owner = repo.split('/')[0];
  return allowList.some((pattern) => {
    if (pattern === repo) return true;
    if (pattern.endsWith('/*')) return repo.startsWith(pattern.slice(0, -1));
    if (!pattern.includes('/')) return owner === pattern;
    return false;
  });
}

function parseAllowReposEnv() {
  const raw = process.env.CHAIN_ALLOW_REPOS;
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function discoverOpenPrs(repos, cwd) {
  const prs = [];
  if (!commandExists('gh')) return prs;
  for (const repo of repos) {
    const result = spawnSync(
      'gh',
      ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (result.status !== 0) {
      throw new Error(`Could not list open PRs for ${repo}: ${result.stderr.trim()}`);
    }
    let data;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Could not parse open PR list for ${repo}`);
    }
    for (const pr of data) {
      if (pr?.number) addUnique(prs, `${repo}#${pr.number}`);
    }
  }
  return prs;
}

function getPrCommentCounts(prs, cwd) {
  const counts = new Map();
  for (const pr of uniqueCanonicalPrs(prs)) {
    const parsed = parsePrRef(pr);
    if (!parsed || !commandExists('gh')) continue;
    const result = spawnSync(
      'gh',
      ['pr', 'view', parsed.number, '--repo', parsed.repo, '--json', 'comments'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (result.status !== 0) continue;
    try {
      const data = JSON.parse(result.stdout);
      counts.set(canonicalPrRef(pr), Array.isArray(data.comments) ? data.comments.length : 0);
    } catch {
      // Leave unparseable PRs out of verification rather than failing the chain.
    }
  }
  return counts;
}

function getPrMergeInfos(prs, cwd) {
  const infos = new Map();
  for (const pr of prs) {
    const parsed = parsePrRef(pr);
    if (!parsed || !commandExists('gh')) continue;
    const result = spawnSync(
      'gh',
      [
        'pr',
        'view',
        parsed.number,
        '--repo',
        parsed.repo,
        '--json',
        'state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,url,headRefName,baseRefName',
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (result.status !== 0) continue;
    try {
      infos.set(pr, JSON.parse(result.stdout));
    } catch {
      // Leave unparseable PRs out of verification rather than failing the chain.
    }
  }
  return infos;
}

function mergeCleanOpenPrs(prs, cwd, opts = {}) {
  // readyDrafts: the chain's own iteration loop may ready its own draft (it just
  // finished the review itself). The ORCHESTRATOR's merge lane must NOT — a draft
  // there means the worker never finished its review (checksArePassing() is
  // vacuously true in repos with no CI, so readying drafts would merge unreviewed
  // work). Pool mode passes false and routes stale drafts through the fix lane.
  const { readyDrafts = true } = opts;
  const results = [];
  const infos = getPrMergeInfos(prs, cwd);
  const baseBranches = new Set([...infos.values()].map((info) => info.baseRefName).filter(Boolean));
  for (const [pr, info] of infos.entries()) {
    const parsed = parsePrRef(pr);
    if (!parsed || info.state !== 'OPEN') continue;
    if (info.reviewDecision === 'CHANGES_REQUESTED') continue;
    if (!checksArePassing(info.statusCheckRollup)) continue;

    if (info.isDraft) {
      if (!readyDrafts) continue;
      const ready = spawnSync('gh', ['pr', 'ready', parsed.number, '--repo', parsed.repo], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      results.push({
        pr,
        command: `gh pr ready ${parsed.number} --repo ${parsed.repo}`,
        status: ready.status,
        output: `${ready.stdout}${ready.stderr}`.trim(),
      });
      if (ready.status !== 0) continue;
    }

    const mergeArgs = ['pr', 'merge', parsed.number, '--repo', parsed.repo, '--merge'];
    if (!baseBranches.has(info.headRefName)) mergeArgs.push('--delete-branch');
    const merge = spawnSync('gh', mergeArgs, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    results.push({
      pr,
      command: `gh ${mergeArgs.join(' ')}`,
      status: merge.status,
      output: `${merge.stdout}${merge.stderr}`.trim(),
    });
    if (merge.status === 0) continue;

    // Queued merges must also delete the branch, or auto-merged PRs leave their
    // remote branches behind forever (the main source of abandoned branches).
    const autoArgs = ['pr', 'merge', parsed.number, '--repo', parsed.repo, '--auto', '--merge'];
    if (!baseBranches.has(info.headRefName)) autoArgs.push('--delete-branch');
    const autoMerge = spawnSync('gh', autoArgs, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    results.push({
      pr,
      command: `gh ${autoArgs.join(' ')}`,
      status: autoMerge.status,
      output: `${autoMerge.stdout}${autoMerge.stderr}`.trim(),
    });
  }
  return results;
}

function formatMergeResults(results) {
  if (results.length === 0) return '(no script-level merge attempts)';
  return results
    .map(
      (result) =>
        `${result.pr}: ${result.command} -> ${result.status}${result.output ? `\n${result.output}` : ''}`
    )
    .join('\n\n');
}

function localRepoDir(repo, workspace) {
  const name = repo.includes('/') ? repo.split('/')[1] : repo;
  return join(workspace, name);
}

function runGit(gitArgs, cwd) {
  const result = spawnSync('git', gitArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function parseWorktrees(porcelain) {
  const list = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: '' };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  if (cur) list.push(cur);
  return list;
}

// A worktree under a temp dir is agent scratch space — safe to drop between
// iterations since removing a worktree never deletes its branch or committed history.
function isScratchPath(p) {
  return isTempPath(p);
}

// Best-effort local housekeeping run between iterations: drop the agents' temp
// worktrees and merged PR branches (upstream gone). Never touches the main checkout,
// the current/default branch, branches with live upstreams, or local-only branches
// (which may hold unpushed work). Removing a worktree keeps its branch and history.
function cleanupGitRepos(repos, workspace) {
  const results = [];
  if (!commandExists('git')) return results;
  const seen = new Set();
  for (const repo of repos) {
    const dir = localRepoDir(repo, workspace);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (!existsSync(join(dir, '.git'))) continue;
    if (runGit(['rev-parse', '--is-inside-work-tree'], dir).stdout !== 'true') continue;

    const actions = [];
    const pruned = runGit(['worktree', 'prune', '-v'], dir);
    if (pruned.stdout) actions.push(`worktree prune: ${pruned.stdout.replace(/\n/g, '; ')}`);

    // Needed so merged PR branches (remote deleted via --delete-branch) show [gone].
    runGit(['remote', 'prune', 'origin'], dir);

    const current = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir).stdout;
    const defaultBranch =
      runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], dir).stdout.replace(
        /^origin\//,
        ''
      ) || 'main';

    const goneBranches = runGit(
      ['for-each-ref', '--format', '%(refname:short)\t%(upstream:track)', 'refs/heads'],
      dir
    )
      .stdout.split('\n')
      .map((line) => line.split('\t'))
      .filter(([, track]) => track && track.includes('[gone]'))
      .map(([name]) => name)
      .filter(Boolean);
    const goneSet = new Set(goneBranches);

    // Remove the main checkout's siblings: temp/scratch worktrees and any worktree
    // holding a gone branch. git lists the main worktree first; never remove it.
    const worktrees = parseWorktrees(runGit(['worktree', 'list', '--porcelain'], dir).stdout);
    const mainPath = worktrees[0]?.path;
    for (const wt of worktrees) {
      if (!wt.path || wt.path === dir || wt.path === mainPath) continue;
      if (!isScratchPath(wt.path) && !(wt.branch && goneSet.has(wt.branch))) continue;
      const removed = runGit(['worktree', 'remove', '--force', wt.path], dir);
      actions.push(
        `worktree remove ${wt.path}${wt.branch ? ` (${wt.branch})` : ''}: ${
          removed.status === 0 ? 'ok' : removed.stderr || 'failed'
        }`
      );
    }

    // Delete merged branches now that no worktree holds them; spare current/default.
    for (const branch of goneBranches) {
      if (branch === current || branch === defaultBranch) continue;
      const deleted = runGit(['branch', '-D', branch], dir);
      actions.push(`branch -D ${branch}: ${deleted.status === 0 ? 'ok' : deleted.stderr || 'failed'}`);
    }

    if (actions.length > 0) results.push({ repo, dir, actions });
  }
  return results;
}

function formatCleanupResults(results) {
  if (results.length === 0) return '(no local branches/worktrees to clean)';
  return results
    .map((r) => `${r.repo} (${r.dir}):\n${r.actions.map((a) => `  - ${a}`).join('\n')}`)
    .join('\n\n');
}

function checksArePassing(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) return true;
  return statusCheckRollup.every((check) => {
    if (check.status && check.status !== 'COMPLETED') return false;
    return ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion);
  });
}

function queueHasOpenPrs(mergeInfos) {
  // null => unknown (dry-run, or gh could not fetch any tracked PR). Callers treat
  // null as "assume work may remain" and keep the strict comment requirement.
  if (!mergeInfos || mergeInfos.size === 0) return null;
  return [...mergeInfos.values()].some((info) => info && info.state === 'OPEN');
}

function assertReadyPrsMerged(prs, mergeInfos, builderOutput, logPath) {
  if (mergeInfos.size === 0) return;
  // Only flag PRs that are genuinely mergeable right now. BLOCKED (branch protection),
  // DIRTY (conflicts), BEHIND, UNKNOWN, DRAFT, etc. cannot be merged by the chain, so a
  // PR left open in one of those states is expected — not a failure.
  const shouldBeMerged = [...mergeInfos.entries()].filter(([, info]) => {
    if (info.state !== 'OPEN') return false;
    if (info.isDraft) return false;
    if (info.reviewDecision === 'CHANGES_REQUESTED') return false;
    if (info.mergeStateStatus !== 'CLEAN') return false;
    if (!checksArePassing(info.statusCheckRollup)) return false;
    return true;
  });
  if (shouldBeMerged.length === 0) return;

  const detail = shouldBeMerged
    .slice(0, 10)
    .map(([pr, info]) => `${pr} (${info.url || 'no url'}, mergeState=${info.mergeStateStatus || 'unknown'})`)
    .join(', ');
  const more = shouldBeMerged.length > 10 ? ` (+${shouldBeMerged.length - 10} more)` : '';
  // Non-fatal: a clean, ready PR left unmerged may be intentional (out of scope, or not
  // one of the chain's own PRs). Surface it loudly but keep the chain running.
  console.warn(
    `\nWarning: ${shouldBeMerged.length} clean, ready PR(s) still open after the merge step — continuing. PRs: ${detail}${more}. See ${logPath}`
  );
}

function describeCommentCountChanges(before, after) {
  return [...before.entries()]
    .map(([pr, count]) => `${pr}: ${count} -> ${after.get(pr) ?? 'unknown'}`)
    .join(', ');
}

function commentCountDeltas(before, after) {
  return [...before.entries()].map(([pr, count]) => {
    const next = after.get(pr);
    return {
      pr,
      before: count,
      after: typeof next === 'number' ? next : null,
      delta: typeof next === 'number' ? next - count : 0,
    };
  });
}

function printCommentWarning(label, before, after, logPath) {
  const unchanged = commentCountDeltas(before, after).filter((item) => item.after !== null && item.delta <= 0);
  if (unchanged.length === 0) return;
  console.warn(
    `${label} warning: no new comment on ${unchanged.length} PR(s); continuing because at least one relevant PR was updated. See ${logPath}`
  );
  console.warn(unchanged.map((item) => `${item.pr}: ${item.before} -> ${item.after}`).join(', '));
}

function assertReviewerPostedComments(roles, prs, before, after, reviewerOutput, logPath, queueOpen) {
  if (before.size === 0) return;
  const deltas = commentCountDeltas(before, after);
  const added = deltas.filter((item) => item.delta > 0);
  if (added.length > 0) {
    printCommentWarning(`${roles.reviewer} comment verification`, before, after, logPath);
    return;
  }

  if (queueOpen === false) {
    console.warn(
      `${roles.reviewer} comment verification: no open PRs remain to review; skipping the new-comment requirement. Counts: ${describeCommentCountChanges(
        before,
        after
      )}. See ${logPath}`
    );
    return;
  }

  const verifiedInOutput = /verified present|comment URL|issuecomment-|\/pull\/\d+#issuecomment-/i.test(
    reviewerOutput
  );
  if (verifiedInOutput) {
    console.warn(
      `${roles.reviewer} comment verification warning: output claims a verified comment, but counts did not change for tracked PRs. Continuing. Counts: ${describeCommentCountChanges(
        before,
        after
      )}. See ${logPath}`
    );
    return;
  }

  const claimedUnable =
    /unable to (post|add|create).*comment|could not (post|add|create).*comment|gh .*failed/i.test(
      reviewerOutput
    );
  const detail = describeCommentCountChanges(before, after);
  const reason = claimedUnable
    ? `${roles.reviewer} reported it could not post at least one comment.`
    : `${roles.reviewer} completed without adding a new PR comment.`;
  throw new Error(`${reason} Comment counts: ${detail}. See ${logPath}`);
}

function assertBuilderRepliedToComments(roles, before, after, builderOutput, logPath, queueOpen) {
  if (before.size === 0) return;
  const deltas = commentCountDeltas(before, after);
  const added = deltas.filter((item) => item.delta > 0);
  if (added.length > 0) {
    printCommentWarning(`${roles.builder} comment verification`, before, after, logPath);
    return;
  }

  if (queueOpen === false) {
    console.warn(
      `${roles.builder} comment verification: no open PRs remain in the queue; nothing to reply to or merge, so skipping the new-comment requirement. Counts: ${describeCommentCountChanges(
        before,
        after
      )}. See ${logPath}`
    );
    return;
  }

  const postedInOutput = /posted|commented|issuecomment-|\/pull\/\d+#issuecomment-/i.test(builderOutput);
  if (postedInOutput) {
    console.warn(
      `${roles.builder} comment verification warning: output claims a comment/reply, but counts did not change for tracked PRs. Continuing. Counts: ${describeCommentCountChanges(
        before,
        after
      )}. See ${logPath}`
    );
    return;
  }

  const claimedUnable =
    /unable to (reply|post|add|create).*comment|could not (reply|post|add|create).*comment|gh .*failed/i.test(
      builderOutput
    );
  const detail = describeCommentCountChanges(before, after);
  const reason = claimedUnable
    ? `${roles.builder} reported it could not reply to at least one PR comment.`
    : `${roles.builder} completed without adding a PR comment/reply after ${roles.reviewer} review.`;
  throw new Error(`${reason} Comment counts: ${detail}. See ${logPath}`);
}

function listPrs(prs) {
  return prs.length > 0
    ? prs.map((pr) => `- ${pr}`).join('\n')
    : '- No PR URLs or repo#number references were detected automatically.';
}

function contextExcerpt(text, maxChars = MAX_CONTEXT_CHARS) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed || '(no output captured)';
  const headSize = Math.floor(maxChars * 0.35);
  const tailSize = maxChars - headSize;
  return [
    trimmed.slice(0, headSize),
    `\n... [middle omitted: ${trimmed.length - maxChars} chars] ...\n`,
    trimmed.slice(trimmed.length - tailSize),
  ].join('');
}

function addUniquePrs(prs, text, allowList) {
  const skipped = [];
  for (const pr of normalizePrs(text)) {
    const canonical = canonicalPrRef(pr);
    if (allowList && allowList.length > 0 && !repoAllowed(parsePrRef(canonical)?.repo, allowList)) {
      skipped.push(canonical);
      continue;
    }
    if (!prs.some((existing) => canonicalPrRef(existing) === canonical)) prs.push(canonical);
  }
  return skipped;
}

// Renders the fixed-slice assignment header for a parallel worker. Empty in the
// normal (self-selecting) chain.
function sliceAssignmentBlock(slice, prScope) {
  if (!slice) return '';
  const branch = prScope ? `${prScope}/${slice.id}` : `slice/${slice.id}`;
  const paths =
    Array.isArray(slice.paths) && slice.paths.length > 0
      ? slice.paths.join(', ')
      : '(not explicitly restricted — stay tightly scoped to this slice anyway)';
  return `ASSIGNED SLICE — you are ONE of several parallel workers. Work ONLY on this slice. Do NOT pick, survey for, or switch to any other slice, and do NOT touch, review, or merge any other worker's PR or branch.
- id: ${slice.id}
- repo: ${slice.repo || '(the scoped repo)'}
- title: ${slice.title || ''}
- target paths (edit only files within these; leave everything else untouched): ${paths}
- branch: create and push your work on a branch named "${branch}", with exactly one PR for this slice.
- rationale: ${slice.rationale || ''}
${slice.notes ? `- notes: ${slice.notes}\n` : ''}${
    slice.kind === 'refactor'
      ? 'This is a behavior-preserving REFACTOR slice: split the target file(s) by responsibility into focused modules, keep ALL imports/exports working and the public surface byte-identical, make NO functional change, and ensure the relevant tests + typecheck/lint pass before opening the PR.\n'
      : ''
  }Skip the slice-selection survey entirely — your slice is fixed above.

`;
}

function buildBuilderIterationPrompt({
  iteration,
  totalLoops,
  prs,
  previousBuilderOutput,
  previousReviewerOutput,
  previousBuilderLogPath,
  previousReviewerLogPath,
  roles,
  forceRefactor,
  refactorEvery,
  slice,
  prScope,
  deferMerge,
  plansPath,
}) {
  const sliceBlock = sliceAssignmentBlock(slice, prScope);
  const mergeClause = deferMerge
    ? ' Do NOT merge anything yourself — a separate orchestrator merges PRs after review; your job is to land the work on the PR, address review, and mark it ready.'
    : '';
  const refactorMandate = forceRefactor && !slice
    ? `\n\nSCHEDULED REFACTOR ITERATION — this chain guarantees a large-file refactor every ${refactorEvery} iteration(s), and iteration ${iteration} is one of them. After draining the open PR queue, the NEW slice you pick this iteration MUST be a behavior-preserving large-file refactor per the "Large-file refactors" directive in this prompt — do not pick a feature/plan slice this iteration. Run the line-count survey, choose the largest / most valuable source file over the ${REFACTOR_LINE_THRESHOLD}-line threshold, and split it. Only if NO source file exceeds the threshold (show the survey that proves it) may you fall back to the normal next-most-valuable slice, and say so explicitly in the Slice survey.`
    : '';
  if (iteration === 1) {
    return `${sliceBlock}Iteration ${iteration} of ${totalLoops}.

Open PR queue:
${listPrs(prs)}

Before starting new work, go through all open PRs listed above. ${roles.reviewer}'s posted review comment is the review gate; do not wait for separate human review. Make sure each PR can merge, fix merge conflicts, update stacked PR base branches as needed, mark clean draft PRs ready${deferMerge ? '' : `, and merge every PR whose ${roles.reviewer}-review/check/merge gate is clean`}. Local unrelated dirty files are not a reason to stop: do not touch them, and use gh remote operations or an isolated git worktree/temp clone for conflict resolution. If a PR's merge conflict cannot be cleanly resolved, REIMPLEMENT its change off the current default branch on the SAME PR branch (force-update the PR) rather than abandoning it — never drop the functionality the PR was adding. ${slice ? 'Then build your assigned slice above.' : 'Only after the open PR queue is handled should you pick the next most valuable slice.'}${mergeClause}

${builderBasePrompt(roles, slice, plansPath)}${refactorMandate}`;
  }

  return `${sliceBlock}Iteration ${iteration} of ${totalLoops}.

Continue the agent review chain from the prior iteration. Carry forward the existing PRs and review state. First drain the open PR queue: ${roles.reviewer}'s posted review comment is the review gate; do not wait for separate human review. Make every open PR mergeable, resolve conflicts, update stacked branches/base branches, mark clean drafts ready${deferMerge ? '' : ', and merge every PR whose gate is clean'}. Local unrelated dirty files are not a merge blocker; leave them untouched and use gh remote operations or an isolated git worktree/temp clone when local branch work is needed. If a PR's merge conflict cannot be cleanly resolved, REIMPLEMENT its change off the current default branch on the SAME PR branch (force-update the PR) rather than abandoning it — never drop the functionality the PR was adding. ${slice ? 'Then continue your assigned slice above.' : 'Then find or continue the next most valuable slice from the build plans.'}${mergeClause}

Current PRs:
${listPrs(prs)}

Prior ${roles.builder} (builder) log:
${previousBuilderLogPath || '(none)'}

Prior ${roles.reviewer} (reviewer) log:
${previousReviewerLogPath || '(none)'}

Prior ${roles.reviewer} (reviewer) output excerpt:
---
${contextExcerpt(previousReviewerOutput || '', 9000)}
---

Prior ${roles.builder} (builder) output excerpt:
---
${contextExcerpt(previousBuilderOutput || '', 9000)}
---

Base instruction:
${builderBasePrompt(roles, slice, plansPath)}${refactorMandate}`;
}

function buildReviewerPrompt({ iteration, totalLoops, prs, builderOutput, builderLogPath, roles, slice, deferMerge }) {
  const scopeNote = slice
    ? `Parallel-worker review: this run is scoped to a single slice — "${slice.title || slice.id}" (id ${slice.id}${slice.repo ? `, ${slice.repo}` : ''}). Review ONLY ${roles.builder}'s own PR for this slice; do not review, comment on, or touch other workers' PRs. Also check the change stays within the slice's intended scope${Array.isArray(slice.paths) && slice.paths.length ? ` (target paths: ${slice.paths.join(', ')})` : ''}.\n\n`
    : '';
  return `${scopeNote}Iteration ${iteration} of ${totalLoops}.

Review the result of the previous ${roles.builder} run and check every open PR in the current queue, including PRs passed on the command line and PRs produced or referenced by ${roles.builder}.

Use these PRs if present:
${listPrs(prs)}

If no PR was detected, infer the likely repo/branch from the ${roles.builder} transcript and use GitHub tooling such as gh to find the relevant open PRs. Do not merge anything. Focus on review readiness, failing checks, merge conflicts, reviewer comments, obvious gaps, and whether the work matches the priorities and acceptance criteria in the build plan it came from.

Important GitHub action:
- For every PR you check, publish a top-level GitHub PR comment with your review summary using gh, for example: gh pr comment <number> --repo <owner/repo> --body-file <file>.
- Post the comment even when the PR is draft or there are no blockers.
- The comment must include: PRs checked, blocking issues, non-blocking issues, requested ${roles.builder} follow-up, check status, and whether it is ready for ${roles.builder} to continue.
- Do not introduce or preserve a separate human-review gate. Your posted review comment is the review for this automation.
- If there are no blockers after your review, tell ${roles.builder} ${deferMerge ? 'to make the PR ready for the orchestrator to merge; do not impose a human-review gate ("remain draft", "hold for human review")' : 'to make the PR ready and merge it; do not say "remain draft", "hold for human review", or "do not merge"'}.
- After posting, verify the comment exists with gh pr view --json comments.
- If you cannot post a comment, say exactly why and include the failing command/error.

${roles.builder} transcript log:
${builderLogPath}

${roles.builder} output excerpt:
---
${contextExcerpt(builderOutput)}
---

Return a concise review report with:
- PRs checked
- blocking issues
- non-blocking issues
- comments or review threads ${roles.builder} should respond to
- GitHub comment URL or confirmation that the comment was posted
- whether it is ready for ${roles.builder} to continue`;
}

function buildBuilderFollowupPrompt({
  iteration,
  totalLoops,
  prs,
  builderOutput,
  reviewerOutput,
  builderLogPath,
  reviewerLogPath,
  roles,
  slice,
  deferMerge,
}) {
  const scopeNote = slice
    ? `Parallel-worker follow-up scoped to one slice — "${slice.title || slice.id}" (id ${slice.id}). Act ONLY on your own PR for this slice; do not modify, reply to, or merge other workers' PRs.\n\n`
    : '';
  const mergeInstructions = deferMerge
    ? `- This is a parallel worker — do NOT merge. Once every actionable review item is fixed or explicitly non-applicable, checks are passing, and there are no unresolved blockers, mark the PR ready (gh pr ready <number> --repo <owner/repo>) and STOP. A separate orchestrator merges ready, review-clean PRs in a serial lane; merging here would race other workers.
- Leave a final PR comment stating either "ready for merge" (with the review items handled and the check status), or the exact remaining blocker with the failing command/error.`
    : `- Flip the review gate after reading ${roles.reviewer}'s review comment: once every actionable review item is fixed or explicitly non-applicable, checks are passing, and there are no unresolved blockers, merge the PR. There is no separate human-review gate. "Ready" is only an intermediate state; do not stop after marking it ready.
- If the PR is a draft and the review gate is clean, mark it ready with gh pr ready <number> --repo <owner/repo>.
- Immediately after the PR is no longer draft and the gate is clean, run a non-interactive merge command. Prefer gh pr merge <number> --repo <owner/repo> --merge --delete-branch. If branch protection requires queued/auto merge, use gh pr merge <number> --repo <owner/repo> --auto --merge. If the repo requires squash or rebase instead, use the allowed method.
- Do not leave a PR merely "ready to merge" unless gh pr merge fails because of a concrete repository/branch-protection gate you cannot satisfy with available CLI operations. If merge fails, paste the exact failing command/error into a PR comment.
- Leave a final PR comment stating either "merged" with the checks/comments handled, or "not merged" with the exact remaining repository/branch-protection blocker.`;
  return `${scopeNote}Iteration ${iteration} of ${totalLoops}.

Check the PR comments and review findings after ${roles.reviewer}'s review, then make the appropriate changes and close the loop on GitHub.

PRs discovered so far:
${listPrs(prs)}

Instructions:
- Treat the listed PRs as an open merge queue. Inspect every open PR, not just the one from the latest ${roles.builder} output.
- Existing unrelated dirty files in the local checkout are not a blocker to merging PRs. Leave them untouched. Use gh for remote ready/merge operations, and use a separate git worktree or temp clone for any conflict-resolution work.
- Do not end with "I did not merge anything" merely because the primary local worktree is dirty.
- Determine dependencies between stacked PRs by comparing head/base branches. For a stack, fold leaf/dependent PRs into their base PR branches first, then merge the base PR toward main, so changes are not stranded on an already-merged branch.
- For PRs with merge conflicts or non-clean merge state, check out the PR branch, update it from its base branch, resolve conflicts, run checks, commit the conflict resolution, and push.
- If a PR targets another PR branch, update the dependent PR after the base PR merges so it can merge into its next base.
- Re-read the current PR comments, review threads, and checks after ${roles.reviewer} has posted its comment. Use gh and, when needed, GitHub GraphQL for unresolved review threads.
- Use ${roles.reviewer}'s review report below as the main handoff, but verify against the live PR comments rather than relying only on the transcript.
- For every ${roles.reviewer}/comment/review item, decide one of: fixed, already satisfied, not applicable, or blocked.
- For fixed items, make the code or documentation changes, run the relevant tests/checks, commit if needed, and push to the PR branch.
- Reply to each top-level PR comment with what changed or why no change was needed.
- For inline review threads that are resolvable, reply as needed and resolve them after the fix is pushed. If a thread cannot be resolved from the CLI, leave a clear reply explaining the status.
- If comments expose gaps in the build-plan documents, record those gaps in the relevant plan where they can be picked up at the right time.
- If anything remains blocked, leave a PR comment explaining the blocker, exact attempted command/action, and the next required unblocker.
${mergeInstructions}
- Finish with a concise summary of comments addressed, changes pushed, comments/review threads replied to or resolved, whether the PR was marked ready, whether it was merged, and any remaining blockers.

${roles.builder} step 1 log:
${builderLogPath}

${roles.reviewer} review log:
${reviewerLogPath}

${roles.reviewer} output excerpt:
---
${contextExcerpt(reviewerOutput)}
---

Original ${roles.builder} output excerpt:
---
${contextExcerpt(builderOutput, 9000)}
---`;
}

// Reconcile pass: bring the build-plan documents back in line with what has
// actually merged. Plans follow planning/plan-format.md: "## 4. Phases" holds
// per-slice statuses (pending | building | shipped | blocked-on-Dx) and
// "## 5. Status ledger" holds append-only "verified against <sha> <date>" rows.
function buildReconcilePrompt({ passLabel, plansDir, prs, repos, date, roles }) {
  const repoList =
    repos.length > 0
      ? repos.map((r) => `  - ${r}`).join('\n')
      : '  - (infer from the PRs handled this run)';
  return `Plan reconciliation pass (${passLabel}). Today is ${date}.

GOAL: bring the build-plan documents back in line with what has actually been
built and merged, so the plans stay the single source of truth for the build
pool. Do NOT pick a feature slice, write product code, or touch any code repo —
this is a documentation-reconciliation pass only.

Plans directory: ${plansDir}
(each plan is a <slug>-build-plan.md with sections: ## 1. Overview,
## 2. Architecture, ## 3. Open decisions, ## 4. Phases, ## 5. Status ledger)

Scoped repos to audit against the plans:
${repoList}

PRs handled in this run so far (recently merged work to reflect):
${listPrs(prs)}

Method — be honest and evidence-driven, do not inflate status:
1. Read every *-build-plan.md in the plans directory.
2. For each plan, compare its "## 4. Phases" slice statuses against reality.
   Inspect the scoped repos' REMOTE default branches with git/gh (\`git fetch
   origin\` first — do not trust local working trees; check merged PRs, commit
   subjects, and, for any slice you upgrade to "shipped", the actual files) to
   confirm what landed. Update each slice's status (pending | building |
   shipped | blocked-on-Dx) to match reality. Never mark a slice shipped
   without file- or PR-cited evidence; if you are unsure, leave its status
   as-is and note what proof is missing.
3. For each plan you verified, append ONE row to its "## 5. Status ledger":
   "verified against <sha> ${date}" where <sha> is the default-branch commit of
   the plan's primary repo that you verified against, plus a one-line summary
   of what changed. The ledger is APPEND-ONLY — never rewrite, reorder, or
   delete existing rows.
4. Land the edits. If the plans directory is inside a git repository with a
   GitHub remote, land them the same way every other change lands in this
   automation: branch off origin's default branch, commit, push, and open a PR
   with gh; once its checks are green and there are no blockers, merge it
   yourself (gh pr merge <number> --repo <owner/repo> --merge --delete-branch,
   or --auto --merge if branch protection requires it) — there is no separate
   human-review gate. If merge fails on a concrete branch-protection gate you
   cannot satisfy, leave the PR open and say exactly why. If the plans
   directory is NOT under git, simply edit the files in place.

Finish with: which plan documents changed, the status lines you corrected (with
the evidence), the ledger rows you appended, and — if a PR was opened — its URL
and whether it merged. If nothing has drifted since the last reconciliation,
say so explicitly and change nothing.`;
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateLine(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'pattern', 'description', 'prompt', 'query', 'url']) {
    if (typeof input[key] === 'string' && input[key]) return input[key];
  }
  return JSON.stringify(input);
}

// Turn one claude --output-format stream-json event into a human-readable
// progress line (or null for events not worth showing).
function renderClaudeStreamEvent(event) {
  if (event.type === 'system' && event.subtype === 'init') {
    return `[claude] model ${event.model || '?'} session ${event.session_id || '?'}`;
  }
  if (event.type === 'assistant') {
    const lines = [];
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        lines.push(block.text.trimEnd());
      } else if (block.type === 'tool_use') {
        lines.push(`[tool] ${block.name}: ${truncateLine(oneLine(summarizeToolInput(block.input)), 160)}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }
  if (event.type === 'result') {
    const seconds = typeof event.duration_ms === 'number' ? Math.round(event.duration_ms / 1000) : null;
    const parts = [`[done] ${event.subtype || 'result'}`];
    if (seconds !== null) parts.push(`${seconds}s`);
    if (typeof event.num_turns === 'number') parts.push(`${event.num_turns} turns`);
    if (typeof event.total_cost_usd === 'number') parts.push(`$${event.total_cost_usd.toFixed(2)}`);
    return parts.join(' · ');
  }
  return null;
}

const MODEL_UNAVAILABLE_RE = /currently unavailable|is unavailable|model (is )?not available|no access to/i;

async function runShellStep({ label, command, prompt, cwd, logPath, appendPromptAsArg, dryRun, streamJson, fallback }) {
  console.log(`\n== ${label} ==`);
  console.log(`Command: ${command}${appendPromptAsArg ? ' <prompt-as-arg>' : ' <prompt-on-stdin>'}`);
  console.log(`Log: ${logPath}`);

  if (dryRun) {
    console.log('\nPrompt:\n' + prompt);
    return '';
  }

  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'w' });
  log.write(`$ ${command}\n\n`);
  log.write(`PROMPT:\n${prompt}\n\nOUTPUT:\n`);

  // Always through the POSIX shell — { shell: true } would mean cmd.exe on
  // Windows, which breaks the POSIX quoting these command strings use.
  const shellCommand = appendPromptAsArg ? `${command} ${shellQuote(prompt)}` : command;
  const [shellBin, shellArgs] = shellInvocation(shellCommand);
  const child = spawn(shellBin, shellArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  let output = '';
  // For stream-json steps, the final "result" event carries the assistant's
  // complete answer — that's what downstream prompts need, not the raw JSONL.
  let resultText = null;
  let stdoutBuffer = '';
  const handleStreamLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }
    if (event.type === 'result' && typeof event.result === 'string') {
      resultText = event.result;
    }
    const rendered = renderClaudeStreamEvent(event);
    if (rendered) process.stdout.write(`${rendered}\n`);
  };
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    log.write(text);
    if (!streamJson) {
      process.stdout.write(text);
      return;
    }
    stdoutBuffer += text;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      handleStreamLine(stdoutBuffer.slice(0, newlineIndex));
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
    log.write(text);
  });

  if (!appendPromptAsArg) {
    child.stdin.end(prompt);
  } else {
    child.stdin.end();
  }

  const code = await new Promise((resolveCode) => {
    child.on('close', resolveCode);
  });
  if (streamJson && stdoutBuffer) handleStreamLine(stdoutBuffer);
  log.end(`\n\nEXIT_CODE: ${code}\n`);

  if (code !== 0) {
    // Model-unavailable fallback: when the configured model is gated/rolled out,
    // rewrite the --model token to the fallback and retry the step once. Only the
    // default claude command is eligible; a custom command is left alone.
    if (
      fallback &&
      fallback.fromModel &&
      fallback.toModel &&
      fallback.fromModel !== fallback.toModel &&
      MODEL_UNAVAILABLE_RE.test(output) &&
      command.includes(shellQuote(fallback.fromModel))
    ) {
      console.warn(
        `\n${label}: model '${fallback.fromModel}' is unavailable — retrying with '${fallback.toModel}'.`
      );
      const retryCommand = command.split(shellQuote(fallback.fromModel)).join(shellQuote(fallback.toModel));
      return runShellStep({
        label: `${label} [fallback: ${fallback.toModel}]`,
        command: retryCommand,
        prompt,
        cwd,
        logPath,
        appendPromptAsArg,
        dryRun,
        streamJson,
        fallback: null,
      });
    }
    if (label.toLowerCase().includes('claude') && /not logged in|please run \/login/i.test(output)) {
      const loginCommand = commandExists('claude')
        ? 'claude auth login'
        : 'npx -y @anthropic-ai/claude-code@latest auth login';
      throw new Error(
        `${label} is not logged in. Run this once, then rerun the chain:\n  ${loginCommand}\nSee ${logPath}`
      );
    }
    throw new Error(`${label} exited with code ${code}. See ${logPath}`);
  }

  return streamJson && resultText !== null ? resultText : output;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.workspace)) {
    throw new Error(`Workspace does not exist: ${args.workspace}`);
  }

  mkdirSync(args.logDir, { recursive: true });

  const codexCommand = expandTemplate(
    process.env.CODEX_CHAIN_CMD || defaultCodexCommand(args.workspace),
    args
  );
  const claudeCommand = expandTemplate(process.env.CLAUDE_CHAIN_CMD || defaultClaudeCommand(), args);

  // If the chosen claude model is unavailable at runtime (e.g. access gated),
  // retry that step with the fallback model. Only the default claude command is
  // eligible — we rewrite its --model token; a custom CLAUDE_CHAIN_CMD is left alone.
  const claudeModel = process.env.CLAUDE_CHAIN_MODEL || DEFAULT_CLAUDE_MODEL;
  const claudeFallbackModel = process.env.CLAUDE_CHAIN_FALLBACK_MODEL || DEFAULT_CLAUDE_FALLBACK_MODEL;
  const claudeFallback =
    !process.env.CLAUDE_CHAIN_CMD && claudeFallbackModel && claudeFallbackModel !== claudeModel
      ? { fromModel: claudeModel, toModel: claudeFallbackModel }
      : null;

  // The "builder/merger" role runs through the codex slot by default. With
  // --claude-only, the claude slot plays that role too, so the chain needs no
  // codex binary at all.
  const claudeAppendPromptAsArg = process.env.CLAUDE_CHAIN_STDIN !== '1';
  // Only the default claude command carries the stream-json flags; a custom
  // CLAUDE_CHAIN_CMD may emit plain text, so leave its output untouched.
  const claudeStreamJson = !process.env.CLAUDE_CHAIN_CMD;
  // Claude builds when running claude-only or when roles are swapped; the
  // reviewer slot runs codex only in swapped mode.
  const claudeIsBuilder = args.claudeOnly || args.swapRoles;
  // Display labels for the prompts. The orchestrator overrides these when a
  // different provider fills a slot (e.g. a user-added agent script).
  const builderName =
    process.env.CHAIN_BUILDER_LABEL || (claudeIsBuilder ? 'Claude' : 'Codex');
  const reviewerName = process.env.CHAIN_REVIEWER_LABEL || (args.swapRoles ? 'Codex' : 'Claude');
  const roles = { builder: builderName, reviewer: reviewerName };
  const builderCommand = claudeIsBuilder ? claudeCommand : codexCommand;
  const builderAppendPromptAsArg = claudeIsBuilder ? claudeAppendPromptAsArg : false;
  const builderStreamJson = claudeIsBuilder && claudeStreamJson;

  // In --claude-only mode, run the middle review step at higher effort. A fully
  // custom CLAUDE_CHAIN_CMD is left untouched since we cannot safely rewrite its flags.
  const reviewCommand = args.swapRoles
    ? codexCommand
    : args.claudeOnly && !process.env.CLAUDE_CHAIN_CMD
      ? expandTemplate(defaultClaudeCommand(CLAUDE_ONLY_REVIEW_EFFORT), args)
      : claudeCommand;
  const reviewAppendPromptAsArg = args.swapRoles ? false : claudeAppendPromptAsArg;
  const reviewStreamJson = args.swapRoles ? false : claudeStreamJson;
  // Model fallback applies only to steps actually run by the default claude command.
  const builderFallback = claudeIsBuilder ? claudeFallback : null;
  const reviewFallback = args.swapRoles ? null : claudeFallback;

  if (!args.dryRun) {
    if (!args.claudeOnly) {
      preflightCommand('Builder', codexCommand, 'CODEX_CHAIN_CMD');
    }
    preflightCommand('Reviewer', claudeCommand, 'CLAUDE_CHAIN_CMD');
  }

  // Repo allow-list: explicit --allow-repo / CHAIN_ALLOW_REPOS if given, else default
  // to the repos the run is explicitly scoped to (--repo plus repos from --prs). PRs
  // for any other repo that agents mention are ignored, so the chain never wanders
  // into unrelated repos (e.g. a public upstream with hundreds of open PRs).
  const allowList =
    args.allowRepos.length > 0
      ? args.allowRepos
      : reposFromPrs(uniqueCanonicalPrs(normalizePrs(args.prSeed))).reduce(
          (acc, repo) => (addUnique(acc, repo), acc),
          [...args.repos]
        );
  console.log(
    `Repo allow-list: ${allowList.length > 0 ? allowList.join(', ') : '(none — all repos allowed)'}`
  );
  const prs = uniqueCanonicalPrs(normalizePrs(args.prSeed)).filter((pr) =>
    repoAllowed(parsePrRef(pr)?.repo, allowList)
  );
  // Track PRs from agent output, dropping (and reporting) any out-of-scope refs.
  const track = (text) => {
    const skipped = addUniquePrs(prs, text, allowList);
    if (skipped.length > 0) {
      const skippedRepos = [...new Set(skipped.map((ref) => parsePrRef(ref)?.repo).filter(Boolean))];
      console.log(`  (ignored ${skipped.length} out-of-scope PR ref(s): ${skippedRepos.join(', ')})`);
    }
  };
  const repos = [...args.repos];
  for (const repo of reposFromPrs(prs)) addUnique(repos, repo);
  if (args.discoverOpenPrs && repos.length > 0) {
    for (const pr of discoverOpenPrs(repos, args.workspace)) {
      if (repoAllowed(parsePrRef(pr)?.repo, allowList)) addUnique(prs, pr);
    }
    console.log(`Discovered open PRs: ${prs.length > 0 ? prs.join(', ') : '(none)'}`);
  }
  let reconcileEnabled = args.reconcile;
  if (reconcileEnabled && !args.dryRun && !existsSync(args.plansPath)) {
    console.warn(
      `Plan reconciliation disabled: ${args.plansPath} does not exist. Point --plans-dir at your build plans, or pass --no-reconcile to silence this.`
    );
    reconcileEnabled = false;
  }

  // Runs one plan-reconcile pass: updates slice statuses + status-ledger rows in
  // the build-plan documents so they stay consistent with what merged, and tracks
  // any PR it opens so the normal queue logic can see it.
  const runReconcilePass = async (passLabel, logPath) => {
    const out = await runShellStep({
      label: `Reconcile plans (${passLabel})`,
      command: builderCommand,
      prompt: buildReconcilePrompt({
        passLabel,
        plansDir: args.plansPath,
        prs,
        repos: [...new Set([...args.repos, ...reposFromPrs(prs)])],
        date: today(),
        roles,
      }),
      cwd: args.workspace,
      logPath,
      appendPromptAsArg: builderAppendPromptAsArg,
      dryRun: args.dryRun,
      streamJson: builderStreamJson,
      fallback: builderFallback,
    });
    track(out);
    return out;
  };

  let previousBuilderOutput = '';
  let previousReviewerOutput = '';
  let previousBuilderLogPath = '';
  let previousReviewerLogPath = '';
  let lastIterationReconciled = false;
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 5;

  for (let iteration = 1; iteration <= args.loops; iteration += 1) {
    const label = String(iteration).padStart(3, '0');
    const iterationDir = join(args.logDir, `iteration-${label}`);
    const builder1LogPath = join(iterationDir, '01-builder.log');
    const reviewerLogPath = join(iterationDir, '02-reviewer.log');
    const builder2LogPath = join(iterationDir, '03-builder.log');

    console.log(`\n######## Iteration ${iteration} of ${args.loops} ########`);

    try {
    const forceRefactor = args.refactorEvery >= 1 && iteration % args.refactorEvery === 0;
    if (forceRefactor) {
      console.log(`(scheduled refactor iteration — guaranteed every ${args.refactorEvery})`);
    }
    const builder1Prompt = buildBuilderIterationPrompt({
      iteration,
      totalLoops: args.loops,
      prs,
      previousBuilderOutput,
      previousReviewerOutput,
      previousBuilderLogPath,
      previousReviewerLogPath,
      roles,
      forceRefactor,
      refactorEvery: args.refactorEvery,
      slice: args.slice,
      prScope: args.prScope,
      deferMerge: args.deferMerge,
      plansPath: args.plansPath,
    });
    const builder1Out = await runShellStep({
      label: `${builderName} 1 (${iteration}/${args.loops})`,
      command: builderCommand,
      prompt: builder1Prompt,
      cwd: args.workspace,
      logPath: builder1LogPath,
      appendPromptAsArg: builderAppendPromptAsArg,
      dryRun: args.dryRun,
      streamJson: builderStreamJson,
      fallback: builderFallback,
    });
    track(builder1Out);

    const reviewerPrompt = buildReviewerPrompt({
      iteration,
      totalLoops: args.loops,
      prs,
      builderOutput: builder1Out,
      builderLogPath: builder1LogPath,
      roles,
      slice: args.slice,
      deferMerge: args.deferMerge,
    });
    const commentCountsBeforeReview = args.dryRun
      ? new Map()
      : getPrCommentCounts(prs, args.workspace);
    const reviewerOut = await runShellStep({
      label: `${reviewerName} review (${iteration}/${args.loops})`,
      command: reviewCommand,
      prompt: reviewerPrompt,
      cwd: args.workspace,
      logPath: reviewerLogPath,
      appendPromptAsArg: reviewAppendPromptAsArg,
      dryRun: args.dryRun,
      streamJson: reviewStreamJson,
      fallback: reviewFallback,
    });
    const commentCountsAfterReview = args.dryRun
      ? new Map()
      : getPrCommentCounts(prs, args.workspace);
    const mergeInfosAfterReview = args.dryRun ? new Map() : getPrMergeInfos(prs, args.workspace);
    assertReviewerPostedComments(
      roles,
      prs,
      commentCountsBeforeReview,
      commentCountsAfterReview,
      reviewerOut,
      reviewerLogPath,
      queueHasOpenPrs(mergeInfosAfterReview)
    );
    track(reviewerOut);

    const builder2Prompt = buildBuilderFollowupPrompt({
      iteration,
      totalLoops: args.loops,
      prs,
      builderOutput: builder1Out,
      reviewerOutput: reviewerOut,
      builderLogPath: builder1LogPath,
      reviewerLogPath,
      roles,
      slice: args.slice,
      deferMerge: args.deferMerge,
    });
    const commentCountsBeforeBuilder2 = args.dryRun
      ? new Map()
      : getPrCommentCounts(prs, args.workspace);
    const builder2Out = await runShellStep({
      label: `${builderName} 2 (${iteration}/${args.loops})`,
      command: builderCommand,
      prompt: builder2Prompt,
      cwd: args.workspace,
      logPath: builder2LogPath,
      appendPromptAsArg: builderAppendPromptAsArg,
      dryRun: args.dryRun,
      streamJson: builderStreamJson,
      fallback: builderFallback,
    });
    const commentCountsAfterBuilder2 = args.dryRun
      ? new Map()
      : getPrCommentCounts(prs, args.workspace);
    // In --defer-merge (parallel-worker) mode the orchestrator owns merging, so the
    // worker never runs the script-level merge pass.
    const scriptMergeResults =
      args.dryRun || args.deferMerge ? [] : mergeCleanOpenPrs(prs, args.workspace);
    if (scriptMergeResults.length > 0) {
      const mergeLogPath = join(iterationDir, '04-script-merge.log');
      const formatted = formatMergeResults(scriptMergeResults);
      writeFileSync(mergeLogPath, `${formatted}\n`);
      console.log(`\n== Script Merge Pass (${iteration}/${args.loops}) ==`);
      console.log(`Log: ${mergeLogPath}`);
      console.log(formatted);
    }
    const mergeInfosAfterBuilder2 = args.dryRun ? new Map() : getPrMergeInfos(prs, args.workspace);
    assertBuilderRepliedToComments(
      roles,
      commentCountsBeforeBuilder2,
      commentCountsAfterBuilder2,
      builder2Out,
      builder2LogPath,
      queueHasOpenPrs(mergeInfosAfterBuilder2)
    );
    // A clean, ready, unmerged PR is the expected end state for a deferred-merge
    // worker (the orchestrator merges it), so skip the "should be merged" warning.
    if (!args.deferMerge) {
      assertReadyPrsMerged(
        prs,
        mergeInfosAfterBuilder2,
        `${builder2Out}\n${formatMergeResults(scriptMergeResults)}`,
        builder2LogPath
      );
    }
    track(builder2Out);

    if (!args.dryRun && args.cleanup) {
      const cleanupResults = cleanupGitRepos(
        [...new Set([...args.repos, ...reposFromPrs(prs)])],
        args.workspace
      );
      if (cleanupResults.length > 0) {
        const cleanupLogPath = join(iterationDir, '05-cleanup.log');
        const formatted = formatCleanupResults(cleanupResults);
        writeFileSync(cleanupLogPath, `${formatted}\n`);
        console.log(`\n== Cleanup Pass (${iteration}/${args.loops}) ==`);
        console.log(`Log: ${cleanupLogPath}`);
        console.log(formatted);
      }
    }

    const forceReconcile =
      reconcileEnabled && args.reconcileEvery >= 1 && iteration % args.reconcileEvery === 0;
    if (forceReconcile) {
      console.log(`\n== Reconcile Pass (${iteration}/${args.loops}) ==`);
      await runReconcilePass(
        `iteration ${iteration}/${args.loops}`,
        join(iterationDir, '06-reconcile.log')
      );
    }
    lastIterationReconciled = forceReconcile;

    previousBuilderOutput = builder2Out || builder1Out;
    previousReviewerOutput = reviewerOut;
    previousBuilderLogPath = builder2LogPath;
    previousReviewerLogPath = reviewerLogPath;
      consecutiveFailures = 0;
    } catch (error) {
      // Unrecoverable: every iteration would fail identically, so stop with the
      // clear login message rather than churning through the remaining loops.
      if (/not logged in/i.test(error.message)) throw error;
      consecutiveFailures += 1;
      console.error(
        `\n!! Iteration ${iteration} failed (${consecutiveFailures}/${maxConsecutiveFailures}): ${error.message}`
      );
      try {
        mkdirSync(iterationDir, { recursive: true });
        writeFileSync(join(iterationDir, 'ERROR.log'), `${error.stack || error.message}\n`);
      } catch {}
      // Circuit breaker: bail out if the chain is wedged (repeated failures), but
      // tolerate isolated/transient ones (a flaky gh call, one bad agent run).
      if (consecutiveFailures >= maxConsecutiveFailures) {
        throw new Error(
          `Aborting after ${consecutiveFailures} consecutive iteration failures. Last error: ${error.message}`
        );
      }
      console.error('Continuing to the next iteration.');
    }
  }

  // Guaranteed end-of-run reconciliation so every run finishes with the build
  // plans consistent with what merged — unless the final iteration's cadence
  // pass already did it.
  if (reconcileEnabled && !lastIterationReconciled) {
    console.log('\n######## Final plan reconciliation ########');
    try {
      await runReconcilePass('end of run', join(args.logDir, 'reconcile-final.log'));
    } catch (error) {
      console.error(`\nFinal reconciliation failed (non-fatal): ${error.message}`);
    }
  }

  console.log(`\nDone after ${args.loops} iteration(s). Transcripts: ${args.logDir}`);
}

// Only run the serial chain when invoked directly as a CLI. When imported (by the
// orchestrator), expose the reusable helpers below instead of auto-running.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  });
}

export {
  runShellStep,
  runGit,
  parsePrRef,
  canonicalPrRef,
  normalizePrs,
  uniqueCanonicalPrs,
  getPrMergeInfos,
  getPrCommentCounts,
  mergeCleanOpenPrs,
  formatMergeResults,
  cleanupGitRepos,
  formatCleanupResults,
  discoverOpenPrs,
  checksArePassing,
  defaultCodexCommand,
  defaultClaudeCommand,
  expandTemplate,
  shellQuote,
  commandExists,
  preflightCommand,
  localRepoDir,
  buildReconcilePrompt,
  sliceSelectionProtocol,
  REFACTOR_DIRECTIVE,
};
