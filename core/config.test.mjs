// Unit tests for the config loader (contract: docs/ARCHITECTURE.md §1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, findConfig, CONFIG_FILENAME, CONFIG_DEFAULTS } from './config.mjs';

function tempWorkspace(config, { fileName = CONFIG_FILENAME } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'planforge-config-'));
  const path = join(dir, fileName);
  writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  return { dir, path };
}

test('applies every default to an empty config', (t) => {
  const { dir, path } = tempWorkspace({});
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig(path);
  assert.equal(cfg.configPath, path);
  assert.equal(cfg.workspace, resolve(dir));
  assert.deepEqual(cfg.repos, []);
  assert.equal(cfg.plansDir, 'plans');
  assert.equal(cfg.plansPath, join(resolve(dir), 'plans'));
  assert.equal(cfg.preferences, 'stack-preferences.json');
  assert.equal(cfg.preferencesPath, join(resolve(dir), 'stack-preferences.json'));
  assert.equal(cfg.workers, 3);
  assert.equal(cfg.fixWorkers, 1);
  assert.equal(cfg.maxSlices, 12);
  assert.deepEqual(cfg.providers.builderPriority, ['codex', 'glm', 'claude']);
  assert.deepEqual(cfg.providers.reviewerPriority, ['claude', 'codex', 'glm']);
  assert.deepEqual(cfg.providers.dualRoleAllowed, ['claude']);
  assert.deepEqual(cfg.models, {
    claude: 'claude-fable-5',
    claudeFallback: 'claude-opus-4-8',
    claudeEffort: 'high',
    codex: 'gpt-5.5',
    glm: 'glm-5.2',
  });
});

test('honors explicit values and resolves paths relative to the config file', (t) => {
  const { dir, path } = tempWorkspace({
    workspace: 'checkouts',
    repos: ['acme/app', 'acme/lib'],
    plansDir: 'my-plans',
    preferences: 'prefs.json',
    workers: 5,
    fixWorkers: 2,
    maxSlices: 40,
    providers: {
      builderPriority: ['mistral', 'codex'],
      reviewerPriority: ['claude', 'mistral'],
      dualRoleAllowed: ['claude', 'mistral'],
    },
    models: { claude: 'claude-x', codex: 'gpt-y' },
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig(path);
  assert.equal(cfg.workspace, join(resolve(dir), 'checkouts'));
  assert.deepEqual(cfg.repos, ['acme/app', 'acme/lib']);
  assert.equal(cfg.plansPath, join(resolve(dir), 'checkouts', 'my-plans'));
  assert.equal(cfg.preferencesPath, join(resolve(dir), 'checkouts', 'prefs.json'));
  assert.equal(cfg.workers, 5);
  assert.equal(cfg.fixWorkers, 2);
  assert.equal(cfg.maxSlices, 40);
  assert.deepEqual(cfg.providers.builderPriority, ['mistral', 'codex']);
  assert.deepEqual(cfg.providers.dualRoleAllowed, ['claude', 'mistral']);
  // Partial models override merges with defaults.
  assert.equal(cfg.models.claude, 'claude-x');
  assert.equal(cfg.models.codex, 'gpt-y');
  assert.equal(cfg.models.claudeFallback, 'claude-opus-4-8');
  assert.equal(cfg.models.claudeEffort, 'high');
});

test('accepts a directory and walks up from a nested one', (t) => {
  const { dir, path } = tempWorkspace({ workers: 7 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const nested = join(dir, 'a', 'b', 'c');
  mkdirSync(nested, { recursive: true });
  assert.equal(loadConfig(dir).workers, 7);
  assert.equal(loadConfig(nested).workers, 7, 'walks up from a nested dir');
  assert.equal(findConfig(nested), path);
});

test('ignores unknown keys (forward-compatible, incl. the init "//" header)', (t) => {
  const { dir, path } = tempWorkspace({ '//': ['comment'], somethingNew: true, workers: 2 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(loadConfig(path).workers, 2);
});

test('missing config file throws a clear error', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'planforge-noconfig-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadConfig(dir), new RegExp(`No ${CONFIG_FILENAME}`));
  assert.throws(() => loadConfig(join(dir, 'nope', 'planforge.config.json')), /does not exist/);
  assert.equal(findConfig(dir), null);
});

test('invalid JSON throws with the config path in the message', (t) => {
  const { dir, path } = tempWorkspace('{ not json', {});
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadConfig(path), (e) => e.message.includes(path) && /not valid JSON/.test(e.message));
});

test('rejects bad field types with clear messages', (t) => {
  const cases = [
    [{ workers: 0 }, /"workers" must be an integer >= 1/],
    [{ workers: 'three' }, /"workers"/],
    [{ fixWorkers: -1 }, /"fixWorkers" must be an integer >= 0/],
    [{ maxSlices: 1.5 }, /"maxSlices"/],
    [{ repos: 'acme/app' }, /"repos" must be an array/],
    [{ repos: ['not-a-repo'] }, /owner\/repo/],
    [{ repos: [42] }, /owner\/repo/],
    [{ plansDir: '' }, /"plansDir"/],
    [{ preferences: 3 }, /"preferences"/],
    [{ providers: [] }, /"providers" must be a JSON object/],
    [{ providers: { builderPriority: [] } }, /"providers.builderPriority" must be a non-empty array/],
    [{ providers: { builderPriority: ['bad name!'] } }, /provider names/],
    [{ providers: { reviewerPriority: 'claude' } }, /"providers.reviewerPriority"/],
    [{ models: { claude: '' } }, /"models.claude"/],
    [{ models: { codex: 5 } }, /"models.codex"/],
  ];
  const dirs = [];
  t.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  for (const [config, re] of cases) {
    const { dir, path } = tempWorkspace(config);
    dirs.push(dir);
    assert.throws(() => loadConfig(path), re, `config ${JSON.stringify(config)}`);
  }
});

test('top-level non-object config throws', (t) => {
  const { dir, path } = tempWorkspace('[1,2,3]');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadConfig(path), /must be a JSON object/);
});

test('deduplicates repos and provider names', (t) => {
  const { dir, path } = tempWorkspace({
    repos: ['acme/app', 'acme/app'],
    providers: { builderPriority: ['codex', 'codex', 'claude'] },
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig(path);
  assert.deepEqual(cfg.repos, ['acme/app']);
  assert.deepEqual(cfg.providers.builderPriority, ['codex', 'claude']);
});

test('CONFIG_DEFAULTS match the documented contract', () => {
  assert.equal(CONFIG_DEFAULTS.workers, 3);
  assert.equal(CONFIG_DEFAULTS.fixWorkers, 1);
  assert.equal(CONFIG_DEFAULTS.maxSlices, 12);
  assert.equal(CONFIG_DEFAULTS.plansDir, 'plans');
  assert.equal(CONFIG_DEFAULTS.preferences, 'stack-preferences.json');
  assert.equal(CONFIG_DEFAULTS.models.claude, 'claude-fable-5');
  assert.equal(CONFIG_DEFAULTS.models.claudeFallback, 'claude-opus-4-8');
  assert.equal(CONFIG_DEFAULTS.models.claudeEffort, 'high');
  assert.equal(CONFIG_DEFAULTS.models.codex, 'gpt-5.5');
});
