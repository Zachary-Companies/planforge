// Detect what you can DO with a scaffolded project — start it, build it,
// publish it — from what's actually in its folder. PlanForge is generic, so
// the source of truth is the project itself: its package.json scripts, its
// lockfile, its deploy config. Config can override any command.
//
// Everything here is pure filesystem inspection (no spawning) so the server,
// the CLI, and tests share one detector.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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

// A deploy target we recognize by its config file → a ready-made publish command.
function detectDeployTarget(dir) {
  if (existsSync(join(dir, 'firebase.json'))) return { label: 'Deploy to Firebase', command: 'npx --yes firebase-tools deploy' };
  if (existsSync(join(dir, 'vercel.json')) || existsSync(join(dir, '.vercel'))) return { label: 'Deploy to Vercel', command: 'npx --yes vercel deploy --prod' };
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
  const result = { name, dir, exists: existsSync(dir), kind: 'unknown', packageManager: null, needsInstall: false, actions: [] };
  if (!result.exists) return result;

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

  const spec = [
    { id: 'start', longRunning: true, missing: 'No dev/start script found. Add one to package.json (e.g. "dev": "vite").' },
    { id: 'build', longRunning: false, missing: 'No build script found. Add a "build" script to package.json.' },
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
  return result;
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
