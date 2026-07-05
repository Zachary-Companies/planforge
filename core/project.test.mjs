import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProjectActions, listProjects, localDirForRepo } from './project.mjs';

function proj(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-proj-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
const actionsById = (r) => Object.fromEntries(r.actions.map((a) => [a.id, a]));

test('localDirForRepo takes the basename of owner/repo', () => {
  assert.equal(localDirForRepo('acme/circle-album', '/ws'), join('/ws', 'circle-album'));
  assert.equal(localDirForRepo('circle-album', '/ws'), join('/ws', 'circle-album'));
});

test('detects node scripts and prepends install when node_modules is missing', () => {
  const dir = proj({
    'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', deploy: 'firebase deploy' } }),
    'package-lock.json': '{}',
  });
  const a = actionsById(detectProjectActions(dir));
  assert.equal(a.start.available, true);
  assert.equal(a.start.longRunning, true);
  assert.equal(a.start.command, 'npm install && npm run dev');
  assert.equal(a.build.command, 'npm install && npm run build');
  assert.equal(a.publish.command, 'npm install && npm run deploy');
  assert.equal(a.publish.confirm, true);
});

test('no install prefix once node_modules exists; respects pnpm lockfile', () => {
  const dir = proj({
    'package.json': JSON.stringify({ scripts: { start: 'node .', build: 'tsc' } }),
    'pnpm-lock.yaml': '',
    'node_modules/.keep': '',
  });
  const a = actionsById(detectProjectActions(dir));
  assert.equal(a.start.command, 'pnpm start');
  assert.equal(a.build.command, 'pnpm build');
});

test('publish falls back to a detected deploy target when there is no script', () => {
  const dir = proj({
    'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }),
    'node_modules/.keep': '',
    'firebase.json': '{}',
  });
  const a = actionsById(detectProjectActions(dir));
  assert.equal(a.publish.available, true);
  assert.match(a.publish.command, /firebase-tools deploy/);
  assert.match(a.publish.label, /Firebase/);
});

test('missing actions are reported unavailable with a fix hint', () => {
  const dir = proj({ 'package.json': JSON.stringify({ scripts: {} }), 'node_modules/.keep': '' });
  const a = actionsById(detectProjectActions(dir));
  assert.equal(a.start.available, false);
  assert.match(a.start.reason, /dev\/start script/);
  assert.equal(a.publish.available, false);
});

test('config overrides force or hide commands', () => {
  const dir = proj({ 'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', deploy: 'x' } }), 'node_modules/.keep': '' });
  const a = actionsById(detectProjectActions(dir, { start: 'make run', publish: '' }));
  assert.equal(a.start.command, 'make run');
  assert.ok(!('publish' in a), 'empty override hides the action');
  assert.equal(a.build.available, true); // untouched
});

test('a static site (index.html, no package.json) can be served', () => {
  const dir = proj({ 'index.html': '<h1>hi</h1>' });
  const r = detectProjectActions(dir);
  assert.equal(r.kind, 'static');
  const a = actionsById(r);
  assert.match(a.start.command, /serve/);
});

test('non-existent project reports exists:false and no actions', () => {
  const r = detectProjectActions('/no/such/dir');
  assert.equal(r.exists, false);
  assert.equal(r.actions.length, 0);
});

test('listProjects sorts existing first and applies overrides by name or repo', () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-ws-'));
  mkdirSync(join(ws, 'built'), { recursive: true });
  writeFileSync(join(ws, 'built', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  writeFileSync(join(ws, 'built', 'package-lock.json'), '{}');
  const list = listProjects({
    repos: ['acme/missing', 'acme/built'],
    workspace: ws,
    projectsConfig: { 'acme/built': { start: 'custom-start' } },
  });
  assert.equal(list[0].name, 'built');
  assert.equal(list[0].exists, true);
  assert.equal(actionsById(list[0]).start.command, 'custom-start');
  assert.equal(list[1].exists, false);
});

// ---- git awareness: behind-remote detection drives sync + hints ----
import { spawnSync as sp } from 'node:child_process';
function gitProj() {
  const dir = mkdtempSync(join(tmpdir(), 'pf-gitproj-'));
  const g = (...a) => sp('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  g('init', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'scaffold');
  g('add', '-A'); g('commit', '-m', 'scaffold');
  return { dir, g };
}

test('a scaffold-only checkout behind its remote is syncable with a helpful hint', () => {
  const remote = mkdtempSync(join(tmpdir(), 'pf-remote-'));
  sp('git', ['-C', remote, 'init', '--bare', '-b', 'main']);
  const { dir, g } = gitProj();
  g('remote', 'add', 'origin', remote);
  g('push', '-u', 'origin', 'main');
  // remote gains the real app; local stays at the scaffold commit
  const work = mkdtempSync(join(tmpdir(), 'pf-work-'));
  const gw = (...a) => sp('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  sp('git', ['clone', remote, work]);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }));
  gw('add', '-A'); gw('commit', '-m', 'add app'); gw('push', 'origin', 'main');
  g('fetch', 'origin');

  const r = detectProjectActions(dir);
  assert.equal(r.kind, 'unknown');
  assert.equal(r.git.isRepo, true);
  assert.ok(r.git.behind >= 1);
  assert.equal(r.syncable, true);
  assert.match(r.hint, /behind the remote/);
});

// ---- resource provisioning: detect backing services + a setup command ----
test('firebase.json yields a provision action that sets up firestore + storage', () => {
  const dir = proj({
    'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }),
    'node_modules/.keep': '',
    'firebase.json': JSON.stringify({ firestore: { rules: 'firestore.rules' }, storage: { rules: 'storage.rules' }, hosting: {} }),
  });
  const r = detectProjectActions(dir);
  assert.deepEqual(r.resources.map((x) => x.name).sort(), ['Cloud Storage', 'Firestore']);
  const a = actionsById(r);
  assert.equal(a.provision.available, true);
  // Each service is its own step (so Storage needing a one-time console setup
  // doesn't block Firestore), Firestore first.
  assert.match(a.provision.command, /deploy --only firestore/);
  assert.match(a.provision.command, /deploy --only storage/);
  assert.ok(a.provision.command.indexOf('--only firestore') < a.provision.command.indexOf('--only storage'));
  assert.equal(a.provision.confirm, true);
});

test('docker-compose + prisma provision brings up services then migrates, in order', () => {
  const dir = proj({
    'package.json': JSON.stringify({ scripts: { dev: 'next dev', build: 'next build' } }),
    'node_modules/.keep': '',
    'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n',
    'prisma/schema.prisma': 'datasource db { provider = "postgresql" }',
  });
  const r = detectProjectActions(dir);
  const names = r.resources.map((x) => x.name);
  assert.ok(names.some((n) => /local database/i.test(n)));
  assert.ok(names.some((n) => /local cache/i.test(n)));
  const cmd = actionsById(r).provision.command;
  assert.ok(cmd.indexOf('docker compose up -d') < cmd.indexOf('prisma migrate deploy'), 'services come up before migrations');
});

test('no infra config → provision unavailable with a helpful reason; override forces it', () => {
  const dir = proj({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }), 'node_modules/.keep': '' });
  const plain = actionsById(detectProjectActions(dir));
  assert.equal(plain.provision.available, false);
  assert.match(plain.provision.reason, /backing resources/i);
  const overridden = actionsById(detectProjectActions(dir, { provision: 'make db' }));
  assert.equal(overridden.provision.command, 'make db');
  assert.equal(overridden.provision.available, true);
});

// ---- refreshGitInfo fetches, so the behind-count is current pre-action ----
import { refreshGitInfo } from './project.mjs';
test('refreshGitInfo sees new remote commits without a prior local fetch', () => {
  const remote = mkdtempSync(join(tmpdir(), 'pf-remote2-'));
  sp('git', ['-C', remote, 'init', '--bare', '-b', 'main']);
  const { dir, g } = gitProj();
  g('remote', 'add', 'origin', remote);
  g('push', '-u', 'origin', 'main');
  // Another clone advances the remote; the first checkout never fetches.
  const work = mkdtempSync(join(tmpdir(), 'pf-work2-'));
  sp('git', ['clone', remote, work]);
  const gw = (...a) => sp('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  writeFileSync(join(work, 'new.txt'), 'merged by the pool');
  gw('add', '-A'); gw('commit', '-m', 'pool merge'); gw('push', 'origin', 'main');

  const passive = detectProjectActions(dir);
  assert.equal(passive.git.behind, 0, 'without a fetch the checkout looks current — the trap');
  const fresh = refreshGitInfo(dir);
  assert.ok(fresh.behind >= 1, 'refreshGitInfo fetches and exposes the real gap');
  assert.equal(fresh.dirty, false);
});

// ---- publishBlockers: workspace deps Firebase's Cloud Build cannot install ----
import { publishBlockers } from './project.mjs';
const fbMonorepo = (functionsPkg) => proj({
  'package.json': JSON.stringify({ name: 'root', workspaces: ['functions', 'shared', 'web'] }),
  'firebase.json': JSON.stringify({ functions: { source: 'functions' }, hosting: {} }),
  'functions/package.json': JSON.stringify(functionsPkg),
  'shared/package.json': JSON.stringify({ name: '@app/shared', version: '0.1.0' }),
  'web/package.json': JSON.stringify({ name: '@app/web', version: '0.1.0' }),
});

test('a functions dependency on a workspace sibling is a publish blocker (dev deps too)', () => {
  const asDep = fbMonorepo({ name: '@app/functions', dependencies: { '@app/shared': '0.1.0', express: '^5.0.0' } });
  const b1 = publishBlockers(asDep);
  assert.equal(b1.length, 1);
  assert.match(b1[0].message, /@app\/shared/);
  assert.match(b1[0].message, /workspace package/);
  // Cloud Build resolves devDependencies as well (npm install --package-lock-only).
  const asDev = fbMonorepo({ name: '@app/functions', devDependencies: { '@app/shared': '0.1.0' } });
  assert.equal(publishBlockers(asDev).length, 1);
  // The blocker surfaces on the detection result the UI reads.
  assert.equal(detectProjectActions(asDep).publishBlockers.length, 1);
});

test('vendored (file:) deps, non-member deps, and non-functions projects are not blockers', () => {
  const vendored = fbMonorepo({ name: '@app/functions', dependencies: { '@app/shared': 'file:./app-shared-0.1.0.tgz' } });
  assert.equal(publishBlockers(vendored).length, 0);
  const clean = fbMonorepo({ name: '@app/functions', dependencies: { express: '^5.0.0' } });
  assert.equal(publishBlockers(clean).length, 0);
  // firebase.json without functions → nothing to check
  const hostingOnly = proj({
    'package.json': JSON.stringify({ name: 'root', workspaces: ['web'] }),
    'firebase.json': JSON.stringify({ hosting: {} }),
    'web/package.json': JSON.stringify({ name: '@app/web' }),
  });
  assert.equal(publishBlockers(hostingOnly).length, 0);
  // no workspaces at all → nothing to check
  const noWs = proj({
    'package.json': JSON.stringify({ name: 'solo' }),
    'firebase.json': JSON.stringify({ functions: { source: 'functions' } }),
    'functions/package.json': JSON.stringify({ name: 'fns', dependencies: { express: '^5.0.0' } }),
  });
  assert.equal(publishBlockers(noWs).length, 0);
});

test('publishBlockers handles glob workspaces and multi-codebase functions arrays', () => {
  const dir = proj({
    'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    'firebase.json': JSON.stringify({ functions: [{ source: 'packages/fns', codebase: 'default' }] }),
    'packages/fns/package.json': JSON.stringify({ name: '@app/fns', dependencies: { '@app/lib': '1.0.0' } }),
    'packages/lib/package.json': JSON.stringify({ name: '@app/lib', version: '1.0.0' }),
  });
  const b = publishBlockers(dir);
  assert.equal(b.length, 1);
  assert.match(b[0].message, /packages\/fns\/package\.json/);
});

// ---- verifySteps always reinstalls (repairs a corrupt node_modules) ----
import { verifySteps } from './project.mjs';
test('verifySteps always installs first, even when node_modules exists', () => {
  const withMods = proj({
    'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }),
    'package-lock.json': '{}',
    'node_modules/.keep': '',
  });
  const steps = verifySteps(withMods).map((s) => s.id);
  assert.deepEqual(steps, ['install', 'build', 'test'], 'install runs before build even with node_modules present');

  // pnpm project uses pnpm install
  const pnpmProj = proj({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }), 'pnpm-lock.yaml': '', 'node_modules/.keep': '' });
  assert.equal(verifySteps(pnpmProj)[0].command, 'pnpm install');

  // the npm 'no test specified' placeholder is not a real test
  const noTest = proj({ 'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'echo "Error: no test specified" && exit 1' } }), 'node_modules/.keep': '' });
  assert.deepEqual(verifySteps(noTest).map((s) => s.id), ['install', 'build']);
});
