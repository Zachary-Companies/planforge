// Detect what you can DO with a scaffolded project — start it, build it,
// publish it — from what's actually in its folder. PlanForge is generic, so
// the source of truth is the project itself: its package.json scripts, its
// lockfile, its deploy config. Config can override any command.
//
// Everything here is pure filesystem inspection (no spawning) so the server,
// the CLI, and tests share one detector.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? -1, out: (r.stdout || '').trim() };
}

// Local git state WITHOUT hitting the network — the behind-count reads the
// last-fetched remote ref (the pool fetches every merge pass, so it's current).
function gitInfo(dir) {
  if (!existsSync(join(dir, '.git'))) return { isRepo: false };
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out || null;
  const up = git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = up.code === 0 ? up.out : null;
  let ahead = 0; let behind = 0;
  if (upstream) {
    const parts = (git(dir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).out || '').split(/\s+/);
    ahead = Number(parts[0]) || 0;
    behind = Number(parts[1]) || 0;
  }
  const dirty = git(dir, ['status', '--porcelain']).out.length > 0;
  return { isRepo: true, branch, upstream, ahead, behind, dirty };
}

// Local folder a repo (or slug) checks out to under the workspace.
export function localDirForRepo(repoOrSlug, workspace) {
  const name = String(repoOrSlug).includes('/') ? String(repoOrSlug).split('/').pop() : String(repoOrSlug);
  return join(workspace, name);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Which package manager the project uses, from its lockfile (falls back to npm).
function packageManager(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return { name: 'pnpm', install: 'pnpm install', run: (s) => `pnpm ${s}` };
  if (existsSync(join(dir, 'yarn.lock'))) return { name: 'yarn', install: 'yarn install', run: (s) => `yarn ${s}` };
  if (existsSync(join(dir, 'bun.lockb'))) return { name: 'bun', install: 'bun install', run: (s) => `bun run ${s}` };
  return { name: 'npm', install: 'npm install', run: (s) => `npm run ${s}` };
}

// First matching script name present in package.json, or null.
function firstScript(scripts, names) {
  for (const n of names) if (typeof scripts[n] === 'string' && scripts[n].trim()) return n;
  return null;
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
function firstExisting(dir, names) {
  for (const n of names) if (existsSync(join(dir, n))) return n;
  return null;
}

// What backing resources the project needs (database, storage, cache…) and the
// ordered commands that set them up — derived from the project's own infra
// config, so it works for any stack. `{ needs:[{type,name}], steps:[commands] }`.
// Provisioning real cloud resources needs the user's own auth (the log will show
// any login prompt); this just runs what the project declares.
function detectResources(dir) {
  const needs = [];
  const steps = [];
  const seen = new Set();
  const need = (type, name) => { const k = `${type}:${name}`; if (!seen.has(k)) { seen.add(k); needs.push({ type, name }); } };

  // Local services first (a compose file usually stands up the dev db/cache).
  const compose = firstExisting(dir, ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
  if (compose) {
    const body = readText(join(dir, compose)).toLowerCase();
    if (/postgres|mysql|mariadb|mongo|cockroach/.test(body)) need('database', 'local database (docker)');
    if (/redis|memcached/.test(body)) need('cache', 'local cache (docker)');
    if (/minio|localstack/.test(body)) need('storage', 'local storage (docker)');
    steps.push('docker compose up -d');
  }

  // ORM / migration tooling.
  if (existsSync(join(dir, 'prisma', 'schema.prisma'))) { need('database', 'Prisma database'); steps.push('npx --yes prisma migrate deploy'); }
  else if (firstExisting(dir, ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs'])) { need('database', 'Drizzle database'); steps.push('npx --yes drizzle-kit migrate'); }
  else if (existsSync(join(dir, 'supabase', 'config.toml'))) { need('database', 'Supabase Postgres'); steps.push('npx --yes supabase db push'); }

  // Firebase: deploy each declared service's rules/indexes as its OWN step, so
  // one that needs a one-time console setup (Storage, especially on a fresh
  // project) doesn't block the others. Firestore first — its rules/indexes
  // usually deploy fine and can auto-create the database.
  const fb = readJson(join(dir, 'firebase.json'));
  if (fb && typeof fb === 'object') {
    const fbtools = 'npx --yes firebase-tools';
    if (fb.firestore) { need('database', 'Firestore'); steps.push(`${fbtools} deploy --only firestore --force`); }
    if (fb.database) { need('database', 'Realtime Database'); steps.push(`${fbtools} deploy --only database --force`); }
    if (fb.storage) { need('storage', 'Cloud Storage'); steps.push(`${fbtools} deploy --only storage --force`); }
  }

  // Infrastructure-as-code.
  let entries = [];
  try { entries = readdirSync(dir); } catch { /* ignore */ }
  if (entries.some((f) => f.endsWith('.tf'))) { need('infra', 'Terraform resources'); steps.push('terraform init && terraform apply -auto-approve'); }

  return { needs, steps };
}

// A deploy target we recognize by its config file → a ready-made publish command.
// --force / --yes make the deploys non-interactive: without them the CLI tries
// to prompt (e.g. Firebase's functions artifact cleanup policy) and exits
// non-zero in an automated context even when the deploy itself succeeded.
function detectDeployTarget(dir) {
  if (existsSync(join(dir, 'firebase.json'))) return { label: 'Deploy to Firebase', command: 'npx --yes firebase-tools deploy --force' };
  if (existsSync(join(dir, 'vercel.json')) || existsSync(join(dir, '.vercel'))) return { label: 'Deploy to Vercel', command: 'npx --yes vercel deploy --prod --yes' };
  if (existsSync(join(dir, 'netlify.toml'))) return { label: 'Deploy to Netlify', command: 'npx --yes netlify-cli deploy --prod' };
  return null;
}

/**
 * Inspect a project directory and report the actions available on it.
 * `overrides` (from config.projects[<name>]) can force any command:
 *   { start?, build?, publish? }  — a string command, or "" to hide the action.
 * Returns { name, dir, exists, kind, packageManager, needsInstall, actions: [...] }.
 * Each action: { id, label, command, longRunning, available, reason?, confirm? }.
 */
export function detectProjectActions(dir, overrides = {}) {
  const name = basename(dir);
  const result = { name, dir, exists: existsSync(dir), kind: 'unknown', packageManager: null, needsInstall: false, git: { isRepo: false }, syncable: false, hint: null, resources: [], actions: [] };
  if (!result.exists) return result;

  result.git = gitInfo(dir);
  // The built code often lives on the remote (the pool merges PRs there) but
  // hasn't been pulled into this folder yet. Offer to update; explain the gap.
  result.syncable = Boolean(result.git.isRepo && result.git.upstream && result.git.behind > 0 && !result.git.dirty);

  const pkg = readJson(join(dir, 'package.json'));
  const isNode = pkg && typeof pkg === 'object';
  const isStatic = !isNode && existsSync(join(dir, 'index.html'));
  result.kind = isNode ? 'node' : isStatic ? 'static' : 'unknown';

  const pm = isNode ? packageManager(dir) : null;
  if (pm) result.packageManager = pm.name;
  const needsInstall = isNode && !existsSync(join(dir, 'node_modules'));
  result.needsInstall = needsInstall;
  const withInstall = (cmd) => (needsInstall ? `${pm.install} && ${cmd}` : cmd);

  const scripts = isNode && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const target = detectDeployTarget(dir);

  // Auto-detected commands (before overrides).
  const detected = { start: null, build: null, publish: null };
  if (isNode) {
    const startScript = firstScript(scripts, ['dev', 'start', 'serve', 'preview']);
    if (startScript) detected.start = { command: withInstall(pm.run(startScript)), label: `Start (${pm.name} ${startScript})` };
    const buildScript = firstScript(scripts, ['build']);
    if (buildScript) detected.build = { command: withInstall(pm.run(buildScript)), label: `Build (${pm.name} run build)` };
    const publishScript = firstScript(scripts, ['deploy', 'publish', 'release']);
    if (publishScript) detected.publish = { command: withInstall(pm.run(publishScript)), label: `Publish (${pm.name} ${publishScript})` };
    else if (target) detected.publish = { command: target.command, label: target.label };
  } else if (isStatic) {
    detected.start = { command: 'npx --yes serve .', label: 'Start (serve static files)' };
    if (target) detected.publish = { command: target.command, label: target.label };
  }
  // A deploy target beats a same-named script only when there was no script;
  // but a target should still surface even for a Node project without one.
  if (!detected.publish && target) detected.publish = { command: target.command, label: target.label };

  // Backing resources (db, storage, cache, infra) the app needs to run.
  const resources = detectResources(dir);
  result.resources = resources.needs;
  if (resources.steps.length) {
    detected.provision = { command: withInstall(resources.steps.join(' && ')), label: 'Set up resources' };
  }

  const spec = [
    { id: 'start', longRunning: true, missing: 'No dev/start script found. Add one to package.json (e.g. "dev": "vite").' },
    { id: 'build', longRunning: false, missing: 'No build script found. Add a "build" script to package.json.' },
    { id: 'provision', longRunning: false, confirm: true, missing: 'No backing resources detected. Add the infra config the app needs (schema/migrations, security rules, docker-compose, terraform) — or set projects.<name>.provision.' },
    { id: 'publish', longRunning: false, confirm: true, missing: 'No deploy command detected. Add a "deploy" script, or a firebase.json / vercel.json / netlify.toml — or set projects.' },
  ];
  for (const s of spec) {
    const override = overrides[s.id];
    if (typeof override === 'string') {
      if (!override.trim()) continue; // explicitly hidden
      result.actions.push({ id: s.id, label: s.id[0].toUpperCase() + s.id.slice(1), command: override, longRunning: s.longRunning, available: true, confirm: s.confirm });
      continue;
    }
    const d = detected[s.id];
    result.actions.push(d
      ? { id: s.id, label: d.label, command: d.command, longRunning: s.longRunning, available: true, confirm: s.confirm }
      : { id: s.id, label: s.id[0].toUpperCase() + s.id.slice(1), command: null, longRunning: s.longRunning, available: false, reason: s.missing });
  }

  // A human explanation when nothing is runnable, so a disabled row is never a
  // dead end.
  if (result.kind === 'unknown') {
    if (result.git.behind > 0) {
      result.hint = `This folder is ${result.git.behind} commit${result.git.behind === 1 ? '' : 's'} behind the remote — the built app is on GitHub but not pulled in yet. Click Update to bring it down.`;
    } else if (result.git.dirty) {
      result.hint = 'This folder has uncommitted changes and no package.json/index.html — commit or clean it, or open it in an editor.';
    } else {
      result.hint = 'No recognizable app here yet (no package.json or index.html). If the pool is still building, check back after it merges.';
    }
  }
  return result;
}

// The ordered commands that prove a project actually works: install its deps,
// build it, run its tests. Only the steps that exist are returned (a project
// with no build/test simply verifies nothing). `overrides.build` / `.test`
// (from config.projects[name]) win; overrides.test === "" disables the test
// step. Used by the run's verify-and-repair phase and `planforge verify`.
export function verifySteps(dir, overrides = {}) {
  if (!existsSync(dir)) return [];
  const pkg = readJson(join(dir, 'package.json'));
  if (!pkg || typeof pkg !== 'object') return [];
  const pm = packageManager(dir);
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const steps = [];
  // Always (re)install before verifying, not just when node_modules is absent:
  // an install is idempotent when up to date, picks up deps a repair just added,
  // AND repairs a corrupt/partial node_modules (e.g. an empty @types/node dir
  // that makes tsc fail with TS2688) — a common cause of "the build won't fix".
  steps.push({ id: 'install', command: pm.install });

  if (typeof overrides.build === 'string') { if (overrides.build.trim()) steps.push({ id: 'build', command: overrides.build }); }
  else if (typeof scripts.build === 'string' && scripts.build.trim()) steps.push({ id: 'build', command: pm.run('build') });

  // The npm-init placeholder ("no test specified" && exit 1) is not a real test.
  const realTest = typeof scripts.test === 'string' && scripts.test.trim() && !/no test specified/i.test(scripts.test);
  if (typeof overrides.test === 'string') { if (overrides.test.trim()) steps.push({ id: 'test', command: overrides.test }); }
  else if (realTest) steps.push({ id: 'test', command: pm.run('test') });

  return steps;
}

// Scan the workspace for projects worth showing: every configured repo's local
// dir, plus any scaffolded git folder not in the repo list. Returns detected
// action reports, existing-first.
export function listProjects({ repos = [], workspace, projectsConfig = {} }) {
  const seen = new Set();
  const out = [];
  const add = (repoOrName, repoFull) => {
    const dir = localDirForRepo(repoOrName, workspace);
    if (seen.has(dir)) return;
    seen.add(dir);
    const name = basename(dir);
    const overrides = projectsConfig[repoFull] || projectsConfig[name] || {};
    out.push({ repo: repoFull || null, ...detectProjectActions(dir, overrides) });
  };
  for (const r of repos) add(r, r);
  out.sort((a, b) => Number(b.exists) - Number(a.exists) || a.name.localeCompare(b.name));
  return out;
}
