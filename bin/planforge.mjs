#!/usr/bin/env node
// PlanForge CLI.
//
//   planforge init                      scaffold planforge.config.json + plans/ +
//                                       stack-preferences.json in the current dir
//   planforge plan --answers <file>     turn interview answers into a build plan
//   planforge plan --revise <slug> --feedback <file>   revise a plan in place
//   planforge run [options]             run the continuous build pool
//   planforge ui [--port N]             start the local web UI
//   planforge doctor [--json]           check tools, agents, and config health
//   planforge projects [--json]         list projects + available actions
//   planforge start|build|publish [p]   run / build / publish a project
//   planforge fix [project]             build+test it and auto-repair failures
//
// The CLI is a thin shell: config loading lives in core/config.mjs, the pool in
// core/orchestrator.mjs, prompts in planning/prompts.mjs, and the web UI in
// ui/server.mjs (spawned as a child process — the UI never imports core code).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, CONFIG_FILENAME, CONFIG_DEFAULTS } from '../core/config.mjs';
import { agentInvocation } from '../core/providers.mjs';
import { findPosixShell, IS_WINDOWS, POSIX_SHELL_HINT, shellInvocation } from '../core/platform.mjs';
import { detectProjectActions, listProjects, localDirForRepo, verifySteps } from '../core/project.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log(`PlanForge — idea -> plan -> shipped software.

Usage:
  planforge init
      Scaffold a workspace in the current directory: writes ${CONFIG_FILENAME},
      creates the plans/ directory, and writes an empty stack-preferences.json.
      Existing files are left untouched.

  planforge plan --answers <file.json> [--config <path>] [options]
      Turn a JSON file of interview answers into an implementation-ready build
      plan: draft -> deepen (dig into details) -> consistency review passes
      that find and fix contradictions -> scaffold the project folder with a
      clean git history. Options:
        --passes <n>      consistency review passes (default 2)
        --no-deepen       skip the detail pass
        --quick           one-shot draft only (no deepen, no reviews)
        --no-scaffold     don't create the project folder / git repo
        --dir <name>      project folder name (default: the plan slug)
        --remote <o/name> create a GitHub repo and push (also set by the
                          wizard's GitHub question); --public for public
      The plan file is committed into the plans repo when it is one.

  planforge plan --revise <slug> (--feedback-text "…" | --feedback <file>) [--config <path>]
      Add features to (or change) an existing plan: applies the feedback,
      then runs the same deepen + consistency-review passes as a new plan so
      the additions are just as thorough. Preserves shipped statuses and the
      append-only ledger. --no-deepen / --quick trim the passes.

  planforge run [--seed-slices <file>] [--max-slices <n>] [--workers <n>] [--dry-run]
                [--fix-workers <n>] [--no-fix] [--builder <name>] [--reviewer <name>]
                [--model <provider>=<id>] [--effort <provider>=<level>]
                [--plan-only] [--config <path>]
      Run the continuous multi-agent build pool over the plans (see
      core/orchestrator.mjs --help for every option). --model/--effort are
      repeatable per-run overrides of config "models", e.g.:
        --model claude=claude-opus-4-8 --effort codex=medium
      (providers: claude, claude-fallback (model only), codex, glm)

      --request "<plain English>"      Extra task for this run — the planner
          turns it into a properly-scoped slice (repeatable). Prefix with
          "owner/repo: " to pin the repo. --requests-file <json> loads many
          (array of strings or { repo, text } objects). For hand-authored
          exact slices there is --seed-slices <file> (advanced).

  planforge ui [--port <n>] [--config <path>]
      Start the local web UI (dashboard, plan wizard, preferences form).

  planforge fix [<project>] [--config <path>]
      Point the build pool at a project: it runs the build and tests and, when
      something fails (a type error, a missing dependency, a broken test),
      spends budget diagnosing and repairing it — opening and merging fixes —
      until the build and tests pass. No plan work; just make it green.
      (Same engine runs automatically at the end of every "planforge run".)

  planforge projects [--json]
      List the scaffolded projects and the actions available on each.

  planforge start | build | publish | sync [<project>] [--config <path>]
      Run / build / publish a project, using commands detected from its
      package.json scripts and deploy config (firebase.json, vercel.json,
      netlify.toml). "sync" fast-forwards the local folder to the remote
      (the pool merges to GitHub; sync pulls the built code down).
      Override commands in planforge.config.json under "projects".
      The project name is optional when there is only one.

Config is found by walking up from the current directory (or use --config).`);
}

function need(argv, i, flag) {
  const v = argv[i];
  if (!v || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}

function parseIntFlag(value, flag, { min }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer >= ${min}`);
  return n;
}

// ---------------------------------------------------------------------------
// planforge init
// ---------------------------------------------------------------------------

function cmdInit() {
  const cwd = process.cwd();
  const configPath = join(cwd, CONFIG_FILENAME);
  const created = [];
  const skipped = [];

  if (existsSync(configPath)) {
    skipped.push(CONFIG_FILENAME);
  } else {
    // JSON has no comments, so a "//" key carries the README header. The config
    // loader ignores unknown keys.
    const config = {
      '//': [
        'PlanForge workspace config — see docs/ARCHITECTURE.md in the planforge repo.',
        'workspace: directory holding your target repo checkouts (relative to this file).',
        'repos: the owner/repo list the build pool may plan for, build in, and merge to.',
        'plansDir: where <slug>-build-plan.md documents live (relative to workspace).',
        'preferences: your stack-preferences.json (written by the preferences form / UI).',
        'workers/fixWorkers/maxSlices: pool sizing — parallel builders, reserved fixers, total slice budget per run.',
        'providers: priority order per role; a name maps to core/agents/agent-<name>.mjs (or .sh/.cmd for custom agents).',
        'models: model ids/effort the agent scripts use.',
      ],
      workspace: '.',
      repos: [],
      plansDir: CONFIG_DEFAULTS.plansDir,
      preferences: CONFIG_DEFAULTS.preferences,
      workers: CONFIG_DEFAULTS.workers,
      fixWorkers: CONFIG_DEFAULTS.fixWorkers,
      maxSlices: CONFIG_DEFAULTS.maxSlices,
      providers: {
        builderPriority: [...CONFIG_DEFAULTS.providers.builderPriority],
        reviewerPriority: [...CONFIG_DEFAULTS.providers.reviewerPriority],
        dualRoleAllowed: [...CONFIG_DEFAULTS.providers.dualRoleAllowed],
      },
      models: { ...CONFIG_DEFAULTS.models },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    created.push(CONFIG_FILENAME);
  }

  const plansDir = join(cwd, CONFIG_DEFAULTS.plansDir);
  if (existsSync(plansDir)) {
    skipped.push(`${CONFIG_DEFAULTS.plansDir}/`);
  } else {
    mkdirSync(plansDir, { recursive: true });
    created.push(`${CONFIG_DEFAULTS.plansDir}/`);
  }

  const prefsPath = join(cwd, CONFIG_DEFAULTS.preferences);
  if (existsSync(prefsPath)) {
    skipped.push(CONFIG_DEFAULTS.preferences);
  } else {
    writeFileSync(prefsPath, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
    created.push(CONFIG_DEFAULTS.preferences);
  }

  if (created.length) console.log(`Created: ${created.join(', ')}`);
  if (skipped.length) console.log(`Already present (untouched): ${skipped.join(', ')}`);
  console.log(`
Next steps:
  1. Add your target repos to "repos" in ${CONFIG_FILENAME} (owner/repo, checked out under "workspace").
  2. planforge ui            — fill in stack preferences + run the plan wizard, or
     planforge plan --answers answers.json
  3. planforge run           — build the plans.`);
}

// ---------------------------------------------------------------------------
// planforge plan
// ---------------------------------------------------------------------------

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Pull the plan markdown out of the agent's stdout: prefer a fenced markdown
// block, else start at the first H1 heading, else use the whole output.
function extractPlanDoc(output) {
  const fence = output.match(/```(?:markdown|md)\s*\n([\s\S]*?)```/i);
  if (fence && fence[1].trim()) return fence[1].trim();
  const h1 = output.search(/^# .+$/m);
  if (h1 !== -1) return output.slice(h1).trim();
  return output.trim();
}

function planFileName(doc, answers) {
  const h1 = doc.match(/^# (.+)$/m);
  let slug = slugify(h1 ? h1[1] : '') || slugify(answers.slug || answers.name || answers.title || answers.idea) || 'project';
  slug = slug.replace(/-build-plan$/, '');
  return `${slug}-build-plan.md`;
}

// Cross-platform invocation for an agent path (the PLANFORGE_PLAN_AGENT seam):
// .mjs runs through this Node, .sh through the POSIX shell, anything else directly.
function invocationForPath(path) {
  if (path.endsWith('.mjs')) return [process.execPath, path];
  if (path.endsWith('.sh')) {
    const shell = findPosixShell();
    if (!shell) throw new Error(POSIX_SHELL_HINT);
    return [shell, path];
  }
  return [path];
}

// Look up an interview answer by question id — answers may be a flat record
// ({ id: value }) or an array of { id, label, response|answer|value } objects.
function answerValue(answers, id) {
  if (!answers) return null;
  if (Array.isArray(answers)) {
    const hit = answers.find((a) => a && a.id === id);
    if (!hit) return null;
    return hit.response ?? hit.answer ?? hit.value ?? null;
  }
  if (typeof answers === 'object') return answers[id] ?? null;
  return null;
}

async function cmdPlan(argv) {
  let answersPath = null;
  let configArg = null;
  let reviseSlug = null;
  let feedbackPath = null;
  let feedbackText = null;
  let passes = 2;
  let deepen = true;
  let scaffold = true;
  let dirName = null;
  let remoteArg = null;
  let isPublic = false;
  let planModel = null;
  let planEffort = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--answers') answersPath = resolve(need(argv, ++i, '--answers'));
    else if (argv[i] === '--config') configArg = resolve(need(argv, ++i, '--config'));
    else if (argv[i] === '--revise') reviseSlug = need(argv, ++i, '--revise');
    else if (argv[i] === '--feedback') feedbackPath = resolve(need(argv, ++i, '--feedback'));
    else if (argv[i] === '--feedback-text' || argv[i] === '-m') feedbackText = need(argv, ++i, argv[i]);
    else if (argv[i] === '--passes') passes = parseIntFlag(need(argv, ++i, '--passes'), '--passes', { min: 0 });
    else if (argv[i] === '--no-deepen') deepen = false;
    else if (argv[i] === '--quick') { deepen = false; passes = 0; }
    else if (argv[i] === '--no-scaffold') scaffold = false;
    else if (argv[i] === '--dir') dirName = need(argv, ++i, '--dir');
    else if (argv[i] === '--remote') remoteArg = need(argv, ++i, '--remote');
    else if (argv[i] === '--public') isPublic = true;
    else if (argv[i] === '--model') planModel = need(argv, ++i, '--model');
    else if (argv[i] === '--effort') planEffort = need(argv, ++i, '--effort');
    else throw new Error(`Unknown option for plan: ${argv[i]}`);
  }
  const revising = reviseSlug !== null;
  if (revising && answersPath) throw new Error('Use either --answers (new plan) or --revise, not both.');
  if (feedbackPath && feedbackText) throw new Error('Use either --feedback <file> or --feedback-text "…", not both.');
  if (revising && !feedbackPath && !feedbackText) throw new Error('planforge plan --revise needs your change: --feedback-text "what to change" (or --feedback <file>).');
  if (!revising && !answersPath) throw new Error('planforge plan needs --answers <file.json> for a new plan, or --revise <slug> --feedback-text "…" to change one.');

  let answers = null;
  if (!revising) {
    if (!existsSync(answersPath)) throw new Error(`Answers file not found: ${answersPath}`);
    try {
      answers = JSON.parse(readFileSync(answersPath, 'utf8'));
    } catch (e) {
      throw new Error(`Could not parse ${answersPath} as JSON: ${e.message}`);
    }
  }

  const config = loadConfig(configArg || process.cwd());
  let preferences = null;
  if (existsSync(config.preferencesPath)) {
    try {
      preferences = JSON.parse(readFileSync(config.preferencesPath, 'utf8'));
    } catch (e) {
      console.warn(`Could not parse ${config.preferencesPath} (${e.message}) — continuing without preferences.`);
    }
  }

  // The prompt builders are pure functions owned by the planning component.
  let prompts;
  try {
    prompts = await import('../planning/prompts.mjs');
  } catch (e) {
    throw new Error(`planning/prompts.mjs is required for "planforge plan" (${e.message}).`);
  }

  // The plan is authored by the claude provider (stdin prompt, workdir arg).
  // PLANFORGE_PLAN_AGENT overrides the agent path — a test/UI seam. The
  // default claude agent runs in stream-json mode so every pipeline stage
  // shows live progress (session start, tool calls, completion) instead of
  // minutes of silence; runShellStep renders the events and returns the
  // final result text.
  const { runShellStep, shellQuote } = await import('../core/review-chain.mjs');
  let agentArgv;
  let streamJson = false;
  if (process.env.PLANFORGE_PLAN_AGENT) {
    const seamPath = resolve(process.env.PLANFORGE_PLAN_AGENT);
    if (!existsSync(seamPath)) throw new Error(`PLANFORGE_PLAN_AGENT not found: ${seamPath}`);
    agentArgv = invocationForPath(seamPath);
  } else {
    agentArgv = agentInvocation('claude');
    if (!agentArgv) throw new Error('The claude agent wrapper is missing (core/agents/agent-claude.mjs).');
    streamJson = true;
  }
  process.env.CLAUDE_CHAIN_MODEL = planModel || config.models.claude;
  process.env.CLAUDE_CHAIN_FALLBACK_MODEL = config.models.claudeFallback;
  process.env.CLAUDE_CHAIN_EFFORT = planEffort || config.models.claudeEffort;
  if (streamJson) process.env.CLAUDE_CHAIN_STREAM_JSON = '1';
  const agentCommand = `${agentArgv.map(shellQuote).join(' ')} ${shellQuote(config.workspace)}`;
  const logDir = join(config.workspace, '.planforge', 'plan-logs', new Date().toISOString().replace(/[:.]/g, '-'));
  let stageN = 0;
  const runPlanAgent = (label, prompt) => runShellStep({
    label,
    command: agentCommand,
    prompt,
    cwd: config.workspace,
    logPath: join(logDir, `${String((stageN += 1)).padStart(2, '0')}-${label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.log`),
    appendPromptAsArg: false,
    dryRun: false,
    streamJson,
    fallback: null,
  });
  const stage = (name, detail = '') => console.log(`\n@plan-stage ${name}${detail ? ` ${detail}` : ''}`);

  // Stage 1 — draft (or revise-in-place).
  let doc;
  let revisePath = null;
  if (revising) {
    const slug = reviseSlug.replace(/-build-plan(\.md)?$/, '');
    revisePath = join(config.plansPath, `${slug}-build-plan.md`);
    if (!existsSync(revisePath)) throw new Error(`No plan found for slug "${slug}" (${revisePath})`);
    if (feedbackPath && !existsSync(feedbackPath)) {
      throw new Error(`Feedback file not found: ${feedbackPath}\nEither create it, or pass the change inline: planforge plan --revise ${slug} --feedback-text "what to change"`);
    }
    const currentPlan = readFileSync(revisePath, 'utf8');
    const feedback = feedbackText ?? readFileSync(feedbackPath, 'utf8');
    stage('revise', `(model ${process.env.CLAUDE_CHAIN_MODEL})`);
    const output = await runPlanAgent('Revise plan', prompts.buildRevisePrompt({ currentPlan, feedback, preferences }));
    doc = extractPlanDoc(output);
  } else {
    stage('draft', `(model ${process.env.CLAUDE_CHAIN_MODEL})`);
    const output = await runPlanAgent('Draft plan', prompts.buildInterviewPrompt({ answers, preferences }));
    doc = extractPlanDoc(output);
  }
  if (!doc) throw new Error('The agent returned no plan content.');

  // Stage 2 — deepen: dig into the details until every slice is
  // implementation-ready. Runs for new plans AND revisions, so features added
  // by a revision get the same thorough treatment (skip with --no-deepen).
  if (deepen) {
    stage('deepen');
    const output = await runPlanAgent('Deepen plan', prompts.buildDeepenPrompt({ currentPlan: doc, preferences }));
    const deepened = extractPlanDoc(output);
    if (deepened) doc = deepened;
    else console.warn('Deepen pass returned no document — keeping the draft.');
  }

  // Stage 3 — consistency review passes: find inconsistencies and fix them,
  // stopping early once a pass comes back clean.
  for (let pass = 1; pass <= passes; pass += 1) {
    stage(`review-${pass}`, `of ${passes}`);
    const output = await runPlanAgent(`Consistency review ${pass}`,
      prompts.buildConsistencyReviewPrompt({ currentPlan: doc, preferences, passNumber: pass }));
    if (output.trim().split('\n').pop().trim() === prompts.PLAN_CONSISTENT_MARKER || output.trim() === prompts.PLAN_CONSISTENT_MARKER) {
      console.log(`Review pass ${pass}: consistent — done reviewing.`);
      break;
    }
    const fixed = extractPlanDoc(output);
    if (fixed) {
      doc = fixed;
      console.log(`Review pass ${pass}: inconsistencies fixed.`);
    } else {
      console.warn(`Review pass ${pass}: unparseable reply — keeping the previous version.`);
      break;
    }
  }

  // Stage 4 — write the plan and keep the plans repo clean.
  stage('write');
  let outPath;
  if (revising) {
    outPath = revisePath; // revision updates the plan in place; the prompt preserves the ledger
  } else {
    mkdirSync(config.plansPath, { recursive: true });
    const fileName = planFileName(doc, answers);
    outPath = join(config.plansPath, fileName);
    for (let n = 2; existsSync(outPath); n += 1) {
      outPath = join(config.plansPath, fileName.replace(/\.md$/, `-${n}.md`));
    }
  }
  writeFileSync(outPath, `${doc}\n`);
  const finalSlug = basename(outPath, '.md').replace(/-build-plan$/, '');
  console.log(`\nPlan written: ${outPath}`);
  console.log(`@plan-slug ${finalSlug}`);

  const { commitPlanFile, scaffoldProject } = await import('../core/scaffold.mjs');
  const planCommit = commitPlanFile({
    plansPath: config.plansPath,
    filePath: outPath,
    message: revising
      ? `plan: revise ${finalSlug}`
      : `plan: add ${finalSlug} (draft${deepen ? ' + deepen' : ''}${passes > 0 ? ` + ${passes} review pass(es)` : ''})`,
  });
  if (planCommit.committed) console.log('Plan committed to the plans repository.');

  // Stage 5 — scaffold the project folder + git (new plans only).
  if (!revising && scaffold) {
    stage('scaffold');
    const wantsRepo = String(answerValue(answers, 'github-repo') || '').toLowerCase();
    const remote = remoteArg || (wantsRepo.startsWith('yes') ? true : null);
    const visibility = isPublic || wantsRepo === 'yes-public';
    const result = scaffoldProject({
      workspace: config.workspace,
      slug: finalSlug,
      planDoc: doc,
      planPath: outPath,
      dir: dirName || answerValue(answers, 'project-folder') || null,
      remote,
      isPublic: visibility,
      configPath: config.configPath,
    });
    if (result.created) console.log(`Project folder: ${result.dir}`);
    if (result.committed) console.log('Initialized git and made the first commit.');
    for (const note of result.notes) console.log(`  - ${note}`);
    if (!result.remote && remote === null) {
      console.log('No GitHub repo created (pass --remote <owner/name>, or answer "yes" to the GitHub question in the wizard). The build pool needs one to open PRs.');
    }
  }

  console.log('Review the plan\'s "## 3. Open decisions" — slices gated on a non-Accepted decision will not be built.');
}

// ---------------------------------------------------------------------------
// planforge run
// ---------------------------------------------------------------------------

// Parse "--model claude=claude-opus-4-8" / "--effort codex=medium" style values
// into the models-override key the config uses.
const MODEL_KEYS = { claude: 'claude', 'claude-fallback': 'claudeFallback', codex: 'codex', glm: 'glm' };
const EFFORT_KEYS = { claude: 'claudeEffort', codex: 'codexEffort', glm: 'glmEffort' };
function parseProviderValue(value, flag, keys) {
  const eq = value.indexOf('=');
  if (eq < 1) throw new Error(`${flag} expects <provider>=<value> (e.g. ${flag} claude=…); got "${value}"`);
  const provider = value.slice(0, eq).toLowerCase();
  const key = keys[provider];
  if (!key) throw new Error(`${flag}: unknown provider "${provider}" (expected ${Object.keys(keys).join('/')})`);
  const v = value.slice(eq + 1).trim();
  if (!v && key !== 'glmEffort') throw new Error(`${flag} ${provider}= needs a value`);
  return [key, v];
}

async function cmdRun(argv) {
  const overrides = {};
  let configArg = null;
  const passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') configArg = resolve(need(argv, ++i, '--config'));
    else if (arg === '--model') {
      const [key, v] = parseProviderValue(need(argv, ++i, '--model'), '--model', MODEL_KEYS);
      overrides.models = { ...overrides.models, [key]: v };
    } else if (arg === '--effort') {
      const [key, v] = parseProviderValue(need(argv, ++i, '--effort'), '--effort', EFFORT_KEYS);
      overrides.models = { ...overrides.models, [key]: v };
    } else if (arg === '--request') {
      // Plain-English task for this run; "owner/repo: text" scopes it to a repo.
      const raw = need(argv, ++i, '--request');
      const m = raw.match(/^([\w.-]+\/[\w.-]+):\s*(.+)$/s);
      overrides.requests = [...(overrides.requests || []), m ? { repo: m[1], text: m[2] } : { text: raw }];
    } else if (arg === '--requests-file') {
      const p = resolve(need(argv, ++i, '--requests-file'));
      let arr;
      try {
        arr = JSON.parse(readFileSync(p, 'utf8'));
      } catch (e) {
        throw new Error(`--requests-file: could not read/parse ${p}: ${e.message}`);
      }
      if (!Array.isArray(arr)) throw new Error('--requests-file must contain a JSON array');
      const items = arr.map((r) => (typeof r === 'string' ? { text: r } : { repo: r.repo, text: r.text }));
      overrides.requests = [...(overrides.requests || []), ...items];
    }
    else if (arg === '--seed-slices') overrides.seedSlices = resolve(need(argv, ++i, '--seed-slices'));
    else if (arg === '--max-slices') overrides.maxSlices = parseIntFlag(need(argv, ++i, '--max-slices'), '--max-slices', { min: 1 });
    else if (arg === '--workers') overrides.workers = parseIntFlag(need(argv, ++i, '--workers'), '--workers', { min: 1 });
    else if (arg === '--fix-workers') overrides.fixWorkers = parseIntFlag(need(argv, ++i, '--fix-workers'), '--fix-workers', { min: 0 });
    else if (arg === '--no-fix') overrides.fixWorkers = 0;
    else if (arg === '--no-verify') overrides.verify = false;
    else if (arg === '--verify-only') overrides.verifyOnly = true;
    else if (arg === '--repo') (overrides.repos = overrides.repos || []).push(need(argv, ++i, '--repo'));
    else if (arg === '--builder') overrides.builder = need(argv, ++i, '--builder');
    else if (arg === '--reviewer') overrides.reviewer = need(argv, ++i, '--reviewer');
    else if (arg === '--refactor-every') overrides.refactorEvery = parseIntFlag(need(argv, ++i, '--refactor-every'), '--refactor-every', { min: 0 });
    else if (arg === '--reconcile-every') overrides.reconcileEvery = parseIntFlag(need(argv, ++i, '--reconcile-every'), '--reconcile-every', { min: 0 });
    else if (arg === '--no-reconcile') overrides.reconcile = false;
    else if (arg === '--no-deps-link') overrides.depsLink = false;
    else if (arg === '--plan-only') overrides.planOnly = true;
    else if (arg === '--dry-run') overrides.dryRun = true;
    else passthrough.push(arg);
  }
  if (passthrough.length) throw new Error(`Unknown option for run: ${passthrough[0]}`);

  const config = loadConfig(configArg || process.cwd());
  const { runOrchestrator } = await import('../core/orchestrator.mjs');
  await runOrchestrator(config, overrides);
}

// ---------------------------------------------------------------------------
// planforge fix — make the orchestrator build + test a project and repair any
// failure automatically (no plan work). A focused verify-and-repair run.
// ---------------------------------------------------------------------------

async function cmdFix(argv) {
  let configArg = null;
  let nameArg = null;
  const overrides = { verifyOnly: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') configArg = resolve(need(argv, ++i, '--config'));
    else if (argv[i] === '--max-slices') overrides.maxSlices = parseIntFlag(need(argv, ++i, '--max-slices'), '--max-slices', { min: 1 });
    else if (argv[i] === '--builder') overrides.builder = need(argv, ++i, '--builder');
    else if (argv[i] === '--reviewer') overrides.reviewer = need(argv, ++i, '--reviewer');
    else if (!argv[i].startsWith('--')) nameArg = argv[i];
    else throw new Error(`Unknown option for fix: ${argv[i]}`);
  }
  const config = loadConfig(configArg || process.cwd());
  // Scope to one project's repo when named; the pool needs a GitHub repo to
  // open + merge the repair PR.
  if (nameArg) {
    const project = resolveProject(nameArg, config);
    const repo = project.repo || config.repos.find((r) => r.split('/').pop() === project.name);
    if (!repo) throw new Error(`"${project.name}" isn't in "repos" in planforge.config.json — the fixer opens a PR, so it needs the GitHub repo. Add it there.`);
    overrides.repos = [repo];
  }
  const { runOrchestrator } = await import('../core/orchestrator.mjs');
  await runOrchestrator(config, overrides);
}

// ---------------------------------------------------------------------------
// planforge ui
// ---------------------------------------------------------------------------

async function cmdUi(argv) {
  let port = null; // null = let the server use its default and hunt past collisions
  let configArg = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') port = parseIntFlag(need(argv, ++i, '--port'), '--port', { min: 1 });
    else if (argv[i] === '--config') configArg = resolve(need(argv, ++i, '--config'));
    else throw new Error(`Unknown option for ui: ${argv[i]}`);
  }
  const config = loadConfig(configArg || process.cwd());
  const server = join(ROOT, 'ui', 'server.mjs');
  if (!existsSync(server)) throw new Error(`UI server not found: ${server}`);
  // The UI never imports core code: it gets the config path + port via env and
  // spawns core/orchestrator.mjs itself for runs. PLANFORGE_PORT is only set
  // when the user chose a port — an explicit port fails hard on collision,
  // the default hunts upward for a free one.
  const child = spawn('node', [server], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PLANFORGE_CONFIG: config.configPath,
      ...(port !== null ? { PLANFORGE_PORT: String(port) } : {}),
    },
  });
  await new Promise((resolveP, rejectP) => {
    child.on('error', (err) => rejectP(new Error(`Could not start the UI server: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolveP() : rejectP(new Error(`UI server exited with code ${code}`))));
  });
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// planforge doctor — is this machine ready to plan and build?
// ---------------------------------------------------------------------------

async function cmdDoctor(argv) {
  const asJson = argv.includes('--json');
  let configArg = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') configArg = resolve(need(argv, ++i, '--config'));
  }
  const { checkProvider, selectRoles } = await import('../core/providers.mjs');
  const { spawnSync } = await import('node:child_process');
  const probe = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: (r.status ?? -1) === 0, detail: `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n')[0] || '' };
  };

  const report = { ok: true, checks: [], providers: [], roles: { builder: null, reviewer: null } };
  const add = (name, ok, detail, hint = '') => {
    report.checks.push({ name, ok, detail, hint });
    if (!ok) report.ok = false;
  };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 20, `v${process.versions.node}`, nodeMajor >= 20 ? '' : 'PlanForge needs Node 20 or newer — https://nodejs.org');
  const git = probe('git', ['--version']);
  add('git', git.ok, git.detail, git.ok ? '' : 'Install git: https://git-scm.com');
  if (IS_WINDOWS) {
    const shell = findPosixShell();
    add('shell', Boolean(shell), shell || 'no POSIX shell found', shell ? '' : POSIX_SHELL_HINT);
  }
  const gh = probe('gh', ['auth', 'status']);
  add('gh', gh.ok, gh.ok ? 'authenticated' : gh.detail, gh.ok ? '' : 'Install the GitHub CLI (https://cli.github.com) and run: gh auth login');

  let config = null;
  try {
    config = loadConfig(configArg || process.cwd());
    add('config', true, config.configPath);
    add('repos', config.repos.length > 0, `${config.repos.length} repo(s) in scope`, config.repos.length ? '' : 'Add "owner/repo" entries to "repos" — the pool needs a target. (A plan wizard "yes" to the GitHub question does this for you.)');
    add('plans', existsSync(config.plansPath), config.plansPath, existsSync(config.plansPath) ? '' : 'Run: planforge plan (or the UI wizard) to create your first build plan.');
    add('preferences', existsSync(config.preferencesPath), config.preferencesPath, existsSync(config.preferencesPath) ? '' : 'Optional but recommended: fill in the Preferences form in the UI.');
  } catch (e) {
    add('config', false, e.message, 'Run: planforge init  (in the folder that holds your project checkouts)');
  }

  const providers = config ? config.providers : CONFIG_DEFAULTS.providers;
  const names = [...new Set([...providers.builderPriority, ...providers.reviewerPriority])];
  for (const name of names) {
    const result = checkProvider(name);
    report.providers.push({
      ...result,
      builderRank: providers.builderPriority.indexOf(name) + 1 || null,
      reviewerRank: providers.reviewerPriority.indexOf(name) + 1 || null,
    });
  }
  const availableNames = report.providers.filter((p) => p.available).map((p) => p.name);
  report.roles = selectRoles(availableNames, providers);
  if (!report.roles.builder) report.ok = false;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const mark = (ok) => (ok ? '✔' : '✖');
  console.log('PlanForge doctor\n');
  for (const c of report.checks) {
    console.log(`  ${mark(c.ok)} ${c.name.padEnd(12)} ${c.detail}`);
    if (!c.ok && c.hint) console.log(`      → ${c.hint}`);
  }
  console.log('\n  Agents:');
  for (const p of report.providers) {
    console.log(`  ${mark(p.available)} ${p.name.padEnd(12)} ${p.detail}`);
  }
  if (report.roles.builder) {
    console.log(`\n  With what's available right now: ${report.roles.builder} writes the code, ${report.roles.reviewer} reviews it.`);
    console.log('  Pick different roles in the UI run panel, with planforge run --builder/--reviewer, or by reordering providers in planforge.config.json.');
  } else {
    console.log('\n  ✖ No usable agent found — set up at least one of the agents above (two is better: one writes, one reviews).');
  }
  if (!report.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// planforge projects | start | build | publish — act on a scaffolded project
// ---------------------------------------------------------------------------

function resolveProject(nameArg, config) {
  const projects = listProjects({ repos: config.repos, workspace: config.workspace, projectsConfig: config.projects });
  if (nameArg) {
    const dir = localDirForRepo(nameArg, config.workspace);
    const overrides = config.projects[nameArg] || config.projects[basename(dir)] || {};
    return detectProjectActions(dir, overrides);
  }
  const existing = projects.filter((p) => p.exists);
  if (existing.length === 1) return existing[0];
  if (existing.length === 0) throw new Error('No project folders found in the workspace yet — create a plan (it scaffolds one), or add repos to planforge.config.json.');
  throw new Error(`Which project? Pass a name: ${existing.map((p) => p.name).join(', ')}`);
}

async function cmdProjects(argv) {
  let configArg = null;
  let asJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') configArg = resolve(need(argv, ++i, '--config'));
    else if (argv[i] === '--json') asJson = true;
    else throw new Error(`Unknown option for projects: ${argv[i]}`);
  }
  const config = loadConfig(configArg || process.cwd());
  const projects = listProjects({ repos: config.repos, workspace: config.workspace, projectsConfig: config.projects });
  if (asJson) { console.log(JSON.stringify({ projects }, null, 2)); return; }
  if (projects.length === 0) { console.log('No projects yet. Create a plan (it scaffolds a project folder) or add repos to planforge.config.json.'); return; }
  for (const p of projects) {
    console.log(`\n${p.name}${p.repo ? `  (${p.repo})` : ''}${p.exists ? '' : '  — not checked out locally yet'}`);
    if (!p.exists) continue;
    if (p.syncable) console.log(`  update   git pull --ff-only  (${p.git.behind} behind the remote — run: planforge sync ${p.name})`);
    if (p.hint) console.log(`  note:    ${p.hint}`);
    if (p.resources && p.resources.length) console.log(`  needs:   ${p.resources.map((r) => r.name).join(', ')}`);
    for (const a of p.actions) {
      console.log(a.available ? `  ${a.id.padEnd(8)} ${a.command}` : `  ${a.id.padEnd(8)} (unavailable) ${a.reason}`);
    }
  }
}

async function cmdProjectAction(action, argv) {
  let configArg = null;
  let nameArg = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') configArg = resolve(need(argv, ++i, '--config'));
    else if (!argv[i].startsWith('--')) nameArg = argv[i];
    else throw new Error(`Unknown option for ${action}: ${argv[i]}`);
  }
  const config = loadConfig(configArg || process.cwd());
  const project = resolveProject(nameArg, config);
  if (!project.exists) throw new Error(`Project folder not found: ${project.dir}`);

  // verify = run the project's own build + tests, stopping at the first
  // failure (no auto-repair — that's the pool's job during a run).
  if (action === 'verify') {
    const overrides = config.projects[project.repo] || config.projects[project.name] || {};
    const steps = verifySteps(project.dir, overrides);
    if (!steps.length) { console.log(`${project.name}: nothing to verify (no build or test detected).`); return; }
    console.log(`${project.name}: ${steps.map((s) => s.id).join(' → ')}\n`);
    for (const step of steps) {
      console.log(`\n== ${step.id}: ${step.command} ==`);
      const [b, a] = shellInvocation(step.command);
      const code = await new Promise((r) => spawn(b, a, { cwd: project.dir, stdio: 'inherit', env: process.env }).on('close', r).on('error', () => r(1)));
      if (code !== 0) throw new Error(`Verification failed at "${step.id}" (exit ${code}).`);
    }
    console.log(`\n${project.name}: verified ✔`);
    return;
  }

  // sync = pull the built code down from the remote (fast-forward only, so it
  // never rewrites local work). Not a detected command.
  let command;
  if (action === 'sync') {
    if (!project.git?.isRepo) throw new Error(`${project.name} is not a git repository — nothing to update.`);
    if (project.git.dirty) throw new Error(`${project.name} has uncommitted changes — commit or stash them before updating.`);
    command = 'git pull --ff-only';
  } else {
    const act = project.actions.find((a) => a.id === action);
    if (!act) throw new Error(`Unknown action: ${action}`);
    if (!act.available) throw new Error(`Cannot ${action} ${project.name}: ${act.reason}`);
    command = act.command;
  }

  console.log(`${project.name}: ${command}\n`);
  const [shellBin, shellArgs] = shellInvocation(command);
  const child = spawn(shellBin, shellArgs, { cwd: project.dir, stdio: 'inherit', env: process.env });
  await new Promise((resolveP, rejectP) => {
    child.on('error', (err) => rejectP(new Error(`Could not run ${action}: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolveP() : rejectP(new Error(`${action} exited with code ${code}`))));
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    usage();
    return;
  }
  if (command === 'init') return cmdInit();
  if (command === 'plan') return cmdPlan(rest);
  if (command === 'run') return cmdRun(rest);
  if (command === 'ui') return cmdUi(rest);
  if (command === 'doctor') return cmdDoctor(rest);
  if (command === 'projects') return cmdProjects(rest);
  if (command === 'fix') return cmdFix(rest);
  if (['start', 'build', 'publish', 'provision', 'sync', 'verify'].includes(command)) return cmdProjectAction(command, rest);
  throw new Error(`Unknown command: ${command} (try: init, plan, run, ui, doctor, projects, start, build, publish, provision, sync, verify, fix)`);
}

// npm installs the bin as a symlink, so compare the realpath too.
const selfPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1] ? resolve(process.argv[1]) : '';
let argvReal = argvPath;
try {
  argvReal = realpathSync(argvPath);
} catch {
  /* keep the unresolved path */
}
const invokedDirectly = !!argvPath && (argvPath === selfPath || argvReal === selfPath);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  });
}

export { extractPlanDoc, planFileName, slugify };
