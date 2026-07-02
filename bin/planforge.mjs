#!/usr/bin/env node
// PlanForge CLI.
//
//   planforge init                      scaffold planforge.config.json + plans/ +
//                                       stack-preferences.json in the current dir
//   planforge plan --answers <file>     turn interview answers into a build plan
//   planforge plan --revise <slug> --feedback <file>   revise a plan in place
//   planforge run [options]             run the continuous build pool
//   planforge ui [--port N]             start the local web UI
//
// The CLI is a thin shell: config loading lives in core/config.mjs, the pool in
// core/orchestrator.mjs, prompts in planning/prompts.mjs, and the web UI in
// ui/server.mjs (spawned as a child process — the UI never imports core code).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, CONFIG_FILENAME, CONFIG_DEFAULTS } from '../core/config.mjs';
import { agentScriptFor } from '../core/providers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_UI_PORT = 4173;

function usage() {
  console.log(`PlanForge — idea -> plan -> shipped software.

Usage:
  planforge init
      Scaffold a workspace in the current directory: writes ${CONFIG_FILENAME},
      creates the plans/ directory, and writes an empty stack-preferences.json.
      Existing files are left untouched.

  planforge plan --answers <file.json> [--config <path>]
      Turn a JSON file of interview answers into a build plan document written
      into the workspace's plans directory (plans/<slug>-build-plan.md).

  planforge plan --revise <slug> --feedback <file> [--config <path>]
      Revise an existing plan in place per the feedback text. The revision
      preserves shipped statuses and the status ledger (append-only).

  planforge run [--seed-slices <file>] [--max-slices <n>] [--workers <n>] [--dry-run]
                [--fix-workers <n>] [--no-fix] [--builder <name>] [--reviewer <name>]
                [--plan-only] [--config <path>]
      Run the continuous multi-agent build pool over the plans (see
      core/orchestrator.mjs --help for every option).

  planforge ui [--port <n>] [--config <path>]
      Start the local web UI (dashboard, plan wizard, preferences form).

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
        'providers: priority order per role; a name maps to core/agents/agent-<name>.sh.',
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

// Spawn a provider agent script (stdin prompt, $1 = workdir, exit code) and
// capture its stdout. stderr streams through for visibility.
function runAgent(script, workdir, prompt, env) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(script, [workdir], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      out += text;
      process.stdout.write(text);
    });
    child.on('error', (err) => rejectP(new Error(`Could not run ${script}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolveP(out);
      else rejectP(new Error(`${script} exited with code ${code}`));
    });
    child.stdin.end(prompt);
  });
}

async function cmdPlan(argv) {
  let answersPath = null;
  let configArg = null;
  let reviseSlug = null;
  let feedbackPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--answers') answersPath = resolve(need(argv, ++i, '--answers'));
    else if (argv[i] === '--config') configArg = resolve(need(argv, ++i, '--config'));
    else if (argv[i] === '--revise') reviseSlug = need(argv, ++i, '--revise');
    else if (argv[i] === '--feedback') feedbackPath = resolve(need(argv, ++i, '--feedback'));
    else throw new Error(`Unknown option for plan: ${argv[i]}`);
  }
  const revising = reviseSlug !== null;
  if (revising && answersPath) throw new Error('Use either --answers (new plan) or --revise + --feedback, not both.');
  if (revising && !feedbackPath) throw new Error('planforge plan --revise requires --feedback <file>');
  if (!revising && !answersPath) throw new Error('planforge plan requires --answers <file.json> (or --revise <slug> --feedback <file>)');

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

  let prompt;
  let revisePath = null;
  if (revising) {
    const slug = reviseSlug.replace(/-build-plan(\.md)?$/, '');
    revisePath = join(config.plansPath, `${slug}-build-plan.md`);
    if (!existsSync(revisePath)) throw new Error(`No plan found for slug "${slug}" (${revisePath})`);
    if (!existsSync(feedbackPath)) throw new Error(`Feedback file not found: ${feedbackPath}`);
    const currentPlan = readFileSync(revisePath, 'utf8');
    const feedback = readFileSync(feedbackPath, 'utf8');
    prompt = prompts.buildRevisePrompt({ currentPlan, feedback, preferences });
  } else {
    prompt = prompts.buildInterviewPrompt({ answers, preferences });
  }

  // The plan is authored by the claude provider (stdin prompt, $1 = workdir).
  const script = agentScriptFor('claude');
  if (!existsSync(script)) throw new Error(`Agent script missing: ${script}`);
  const env = {
    ...process.env,
    CLAUDE_CHAIN_MODEL: config.models.claude,
    CLAUDE_CHAIN_FALLBACK_MODEL: config.models.claudeFallback,
    CLAUDE_CHAIN_EFFORT: config.models.claudeEffort,
  };
  console.log(`${revising ? 'Revising' : 'Generating'} build plan (model ${config.models.claude})...\n`);
  const output = await runAgent(script, config.workspace, prompt, env);

  const doc = extractPlanDoc(output);
  if (!doc) throw new Error('The agent returned no plan content.');
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
  console.log('Review its "## 3. Open decisions" — slices gated on a non-Accepted decision will not be built.');
}

// ---------------------------------------------------------------------------
// planforge run
// ---------------------------------------------------------------------------

async function cmdRun(argv) {
  const overrides = {};
  let configArg = null;
  const passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') configArg = resolve(need(argv, ++i, '--config'));
    else if (arg === '--seed-slices') overrides.seedSlices = resolve(need(argv, ++i, '--seed-slices'));
    else if (arg === '--max-slices') overrides.maxSlices = parseIntFlag(need(argv, ++i, '--max-slices'), '--max-slices', { min: 1 });
    else if (arg === '--workers') overrides.workers = parseIntFlag(need(argv, ++i, '--workers'), '--workers', { min: 1 });
    else if (arg === '--fix-workers') overrides.fixWorkers = parseIntFlag(need(argv, ++i, '--fix-workers'), '--fix-workers', { min: 0 });
    else if (arg === '--no-fix') overrides.fixWorkers = 0;
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
// planforge ui
// ---------------------------------------------------------------------------

async function cmdUi(argv) {
  let port = DEFAULT_UI_PORT;
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
  // spawns core/orchestrator.mjs itself for runs.
  const child = spawn('node', [server], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PLANFORGE_CONFIG: config.configPath,
      PLANFORGE_PORT: String(port),
    },
  });
  await new Promise((resolveP, rejectP) => {
    child.on('error', (err) => rejectP(new Error(`Could not start the UI server: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolveP() : rejectP(new Error(`UI server exited with code ${code}`))));
  });
}

// ---------------------------------------------------------------------------

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
  throw new Error(`Unknown command: ${command} (try: init, plan, run, ui)`);
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
