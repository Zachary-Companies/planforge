// Config loader for PlanForge — the single source of truth for where a run
// operates. The workspace, target repos, plans dir, pool sizing, provider
// priorities, and model choices all come from planforge.config.json (contract:
// docs/ARCHITECTURE.md §1). Everything downstream takes the object returned by
// loadConfig(); nothing else reads environment-specific defaults for repos or
// paths.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, join } from 'node:path';

export const CONFIG_FILENAME = 'planforge.config.json';

export const CONFIG_DEFAULTS = Object.freeze({
  workspace: '.',
  repos: Object.freeze([]),
  plansDir: 'plans',
  preferences: 'stack-preferences.json',
  workers: 3,
  fixWorkers: 1,
  maxSlices: 12,
  providers: Object.freeze({
    builderPriority: Object.freeze(['codex', 'glm', 'claude']),
    reviewerPriority: Object.freeze(['claude', 'codex', 'glm']),
    dualRoleAllowed: Object.freeze(['claude']),
  }),
  models: Object.freeze({
    claude: 'claude-fable-5',
    claudeFallback: 'claude-opus-4-8',
    claudeEffort: 'high',
    codex: 'gpt-5.5',
    codexEffort: 'high',
    glm: 'glm-5.2',
    glmEffort: '', // empty = let the provider use its own default
  }),
});

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]*$/i;

// Walk up from startDir looking for planforge.config.json. Returns the absolute
// path of the first hit, or null when the filesystem root is reached without one.
export function findConfig(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function fail(configPath, message) {
  throw new Error(`${configPath}: ${message}`);
}

function assertPlainObject(configPath, value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(configPath, `${label} must be a JSON object`);
  }
}

function intField(configPath, raw, key, { min }) {
  if (raw === undefined) return CONFIG_DEFAULTS[key];
  if (!Number.isInteger(raw) || raw < min) {
    fail(configPath, `"${key}" must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

function stringField(configPath, raw, key) {
  if (raw === undefined) return CONFIG_DEFAULTS[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    fail(configPath, `"${key}" must be a non-empty string (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

// Optional per-project command overrides:
//   "projects": { "<repo-or-name>": { "start": "...", "build": "...", "publish": "..." } }
// An empty string hides that action. Anything else is auto-detected.
function projectsField(configPath, raw) {
  if (raw === undefined) return {};
  assertPlainObject(configPath, raw, '"projects"');
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    assertPlainObject(configPath, val, `"projects.${key}"`);
    const entry = {};
    for (const action of ['start', 'build', 'publish', 'test', 'provision']) {
      if (val[action] === undefined) continue;
      if (typeof val[action] !== 'string') fail(configPath, `"projects.${key}.${action}" must be a string command (or "" to hide it)`);
      entry[action] = val[action];
    }
    out[key] = entry;
  }
  return out;
}

function reposField(configPath, raw) {
  if (raw === undefined) return [...CONFIG_DEFAULTS.repos];
  if (!Array.isArray(raw)) fail(configPath, `"repos" must be an array of "owner/repo" strings`);
  const repos = [];
  for (const repo of raw) {
    if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
      fail(configPath, `"repos" entries must look like "owner/repo" (got ${JSON.stringify(repo)})`);
    }
    if (!repos.includes(repo)) repos.push(repo);
  }
  return repos;
}

function providerListField(configPath, raw, key, fallback, { allowEmpty = false } = {}) {
  if (raw === undefined) return [...fallback];
  if (!Array.isArray(raw) || (!allowEmpty && raw.length === 0)) {
    fail(configPath, `"providers.${key}" must be a non-empty array of provider names`);
  }
  const names = [];
  for (const name of raw) {
    if (typeof name !== 'string' || !PROVIDER_NAME_RE.test(name)) {
      fail(
        configPath,
        `"providers.${key}" entries must be provider names like "codex" or "claude" (got ${JSON.stringify(name)})`
      );
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function providersField(configPath, raw) {
  const d = CONFIG_DEFAULTS.providers;
  if (raw === undefined) {
    return {
      builderPriority: [...d.builderPriority],
      reviewerPriority: [...d.reviewerPriority],
      dualRoleAllowed: [...d.dualRoleAllowed],
    };
  }
  assertPlainObject(configPath, raw, '"providers"');
  return {
    builderPriority: providerListField(configPath, raw.builderPriority, 'builderPriority', d.builderPriority),
    reviewerPriority: providerListField(configPath, raw.reviewerPriority, 'reviewerPriority', d.reviewerPriority),
    dualRoleAllowed: providerListField(configPath, raw.dualRoleAllowed, 'dualRoleAllowed', d.dualRoleAllowed, {
      allowEmpty: true,
    }),
  };
}

// Keys where an empty string is meaningful ("don't pass this knob at all").
const MODELS_ALLOW_EMPTY = new Set(['glmEffort']);

function modelsField(configPath, raw) {
  const d = CONFIG_DEFAULTS.models;
  if (raw === undefined) return { ...d };
  assertPlainObject(configPath, raw, '"models"');
  const out = { ...d };
  for (const key of Object.keys(d)) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || (raw[key].trim() === '' && !MODELS_ALLOW_EMPTY.has(key))) {
      fail(configPath, `"models.${key}" must be a non-empty string (got ${JSON.stringify(raw[key])})`);
    }
    out[key] = raw[key].trim();
  }
  return out;
}

// Load and validate planforge.config.json.
//   loadConfig()            -> walk up from process.cwd()
//   loadConfig('/some/dir') -> walk up from that directory
//   loadConfig('/x/planforge.config.json') -> that exact file
// Returns a validated object with defaults applied plus derived absolute paths
// (workspace, plansPath, preferencesPath). Throws with a clear message for a
// missing file, unparseable JSON, or an invalid field.
export function loadConfig(pathOrDir = process.cwd()) {
  const given = resolve(pathOrDir);
  let configPath;
  if (existsSync(given) && statSync(given).isFile()) {
    configPath = given;
  } else if (existsSync(given) && statSync(given).isDirectory()) {
    configPath = findConfig(given);
    if (!configPath) {
      throw new Error(
        `No ${CONFIG_FILENAME} found in ${given} or any parent directory. Run "planforge init" to create one.`
      );
    }
  } else {
    throw new Error(`Config path does not exist: ${given}`);
  }

  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(`Could not read ${configPath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`${configPath} is not valid JSON: ${error.message}`);
  }
  assertPlainObject(configPath, parsed, 'the config');

  const workspaceRel = stringField(configPath, parsed.workspace, 'workspace');
  const plansDir = stringField(configPath, parsed.plansDir, 'plansDir');
  const preferences = stringField(configPath, parsed.preferences, 'preferences');
  const workers = intField(configPath, parsed.workers, 'workers', { min: 1 });
  const fixWorkers = intField(configPath, parsed.fixWorkers, 'fixWorkers', { min: 0 });
  const maxSlices = intField(configPath, parsed.maxSlices, 'maxSlices', { min: 1 });

  // Paths resolve relative to the config file (the workspace root), never to
  // whatever directory the process happens to run from.
  const workspace = isAbsolute(workspaceRel)
    ? workspaceRel
    : resolve(dirname(configPath), workspaceRel);

  return {
    configPath,
    workspace,
    repos: reposField(configPath, parsed.repos),
    plansDir,
    plansPath: isAbsolute(plansDir) ? plansDir : resolve(workspace, plansDir),
    preferences,
    preferencesPath: isAbsolute(preferences) ? preferences : resolve(workspace, preferences),
    workers,
    fixWorkers,
    maxSlices,
    providers: providersField(configPath, parsed.providers),
    models: modelsField(configPath, parsed.models),
    projects: projectsField(configPath, parsed.projects),
  };
}
