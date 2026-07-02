import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { scaffoldProject, commitPlanFile, extractOverview, planTitle } from './scaffold.mjs';

const PLAN = `# Garden Log build plan
<!-- slug: garden-log -->

## 1. Overview

A tiny app for logging what you planted and when.

Second paragraph with more detail.

## 2. Architecture

- web/
`;

// Real git, but with an inline identity so commits work in any environment.
function gitWithIdentity(args, cwd) {
  const full = ['-c', 'user.name=planforge-test', '-c', 'user.email=test@planforge.local', ...args];
  const r = spawnSync('git', full, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? -1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

test('extractOverview and planTitle pull from the plan doc', () => {
  assert.equal(planTitle(PLAN), 'Garden Log');
  const overview = extractOverview(PLAN);
  assert.match(overview, /logging what you planted/);
  assert.match(overview, /Second paragraph/);
  assert.doesNotMatch(overview, /Architecture/);
});

test('scaffoldProject creates folder, seed files, and a clean initial commit', () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-scaffold-'));
  const result = scaffoldProject({
    workspace: ws, slug: 'garden-log', planDoc: PLAN, planPath: 'plans/garden-log-build-plan.md',
    deps: { runGit: gitWithIdentity },
  });
  assert.equal(result.created, true);
  assert.equal(result.gitInitialized, true);
  assert.equal(result.committed, true);
  assert.equal(result.remote, null);
  const dir = join(ws, 'garden-log');
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /# Garden Log/);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /node_modules/);
  const log = gitWithIdentity(['log', '--oneline'], dir);
  assert.equal(log.stdout.split('\n').length, 1);
  assert.match(log.stdout, /Scaffold Garden Log/);
  const status = gitWithIdentity(['status', '--porcelain'], dir);
  assert.equal(status.stdout, '', 'working tree is clean after scaffold');
});

test('scaffoldProject refuses to touch an existing non-empty non-git directory', () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-scaffold-'));
  const dir = join(ws, 'occupied');
  mkdirSync(dir);
  writeFileSync(join(dir, 'precious.txt'), 'do not clobber');
  const result = scaffoldProject({
    workspace: ws, slug: 'occupied', planDoc: PLAN, deps: { runGit: gitWithIdentity },
  });
  assert.equal(result.created, false);
  assert.equal(result.gitInitialized, false);
  assert.equal(existsSync(join(dir, 'README.md')), false);
  assert.match(result.notes.join(' '), /not touching it/);
  assert.equal(readFileSync(join(dir, 'precious.txt'), 'utf8'), 'do not clobber');
});

test('scaffoldProject creates the remote via gh and registers it in config', () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-scaffold-'));
  const configPath = join(ws, 'planforge.config.json');
  writeFileSync(configPath, JSON.stringify({ workspace: '.', repos: [] }, null, 2));
  const ghCalls = [];
  const runGit = (args, cwd) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { status: 0, stdout: 'https://github.com/tester/garden-log.git', stderr: '' };
    }
    return gitWithIdentity(args, cwd);
  };
  const runGh = (args) => { ghCalls.push(args); return { status: 0, stdout: '', stderr: '' }; };
  const result = scaffoldProject({
    workspace: ws, slug: 'garden-log', planDoc: PLAN,
    remote: true, isPublic: false, configPath,
    deps: { runGit, runGh },
  });
  assert.equal(result.remote, 'tester/garden-log');
  assert.equal(result.configUpdated, true);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).repos, ['tester/garden-log']);
  assert.equal(ghCalls.length, 1);
  assert.equal(ghCalls[0][0], 'repo');
  assert.equal(ghCalls[0][1], 'create');
  assert.ok(ghCalls[0].includes('--private'));
  assert.ok(ghCalls[0].includes('--push'));
});

test('scaffoldProject reports gh failure and stays local-only', () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-scaffold-'));
  const runGh = () => ({ status: 1, stdout: '', stderr: 'gh: not logged in' });
  const result = scaffoldProject({
    workspace: ws, slug: 'garden-log', planDoc: PLAN, remote: 'me/garden-log',
    deps: { runGit: gitWithIdentity, runGh },
  });
  assert.equal(result.committed, true);
  assert.equal(result.remote, null);
  assert.match(result.notes.join(' '), /stays local-only/);
});

test('commitPlanFile commits inside a plans git repo and no-ops outside one', () => {
  const plans = mkdtempSync(join(tmpdir(), 'pf-plans-'));
  gitWithIdentity(['init', '-b', 'main'], plans);
  const file = join(plans, 'garden-log-build-plan.md');
  writeFileSync(file, PLAN);
  const r1 = commitPlanFile({ plansPath: plans, filePath: file, message: 'plan: add garden-log', deps: { runGit: gitWithIdentity } });
  assert.equal(r1.committed, true);
  const r2 = commitPlanFile({ plansPath: plans, filePath: file, message: 'plan: add garden-log', deps: { runGit: gitWithIdentity } });
  assert.equal(r2.committed, false);
  assert.equal(r2.reason, 'nothing to commit');

  const notRepo = mkdtempSync(join(tmpdir(), 'pf-noplans-'));
  const f2 = join(notRepo, 'x-build-plan.md');
  writeFileSync(f2, PLAN);
  const r3 = commitPlanFile({ plansPath: notRepo, filePath: f2, message: 'x', deps: { runGit: gitWithIdentity } });
  assert.equal(r3.committed, false);
  assert.match(r3.reason, /not in a git repository/);
});
