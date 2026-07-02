// Project scaffolding: turn a freshly written build plan into a clean, ready
// repository — create the project folder, seed README/.gitignore from the plan,
// initialize git with an initial commit, and (optionally) create the GitHub
// remote and register it in planforge.config.json so the build pool can open
// and merge PRs against it.
//
// Every git/gh effect goes through injectable runners (deps.runGit/deps.runGh)
// so tests never touch the network or the user's git config.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const GITIGNORE = `node_modules/
dist/
build/
coverage/
.env
.env.*
*.log
.DS_Store
__pycache__/
.venv/
`;

function defaultRunGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? -1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function defaultRunGh(args, cwd) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? -1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// First ~3 paragraphs of "## 1. Overview" — used as the README lead.
export function extractOverview(planDoc) {
  const text = String(planDoc || '');
  const m = text.match(/^##\s*1[.:]?\s+Overview[^\n]*\n([\s\S]*?)(?=^##\s)/m);
  if (!m) return '';
  const paragraphs = m[1].trim().split(/\n\s*\n/).slice(0, 3);
  return paragraphs.join('\n\n').trim();
}

export function planTitle(planDoc) {
  const m = String(planDoc || '').match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].replace(/\s+build plan$/i, '').trim() : null;
}

// Scaffold the project a plan describes. Never destructive: an existing
// non-empty directory that isn't ours is left alone (reported in notes).
export function scaffoldProject({
  workspace,
  slug,
  planDoc,
  planPath = null,
  dir = null,
  remote = null, // null | true (name = slug, private) | 'owner/name'
  isPublic = false,
  configPath = null,
  deps = {},
}) {
  const runGit = deps.runGit || defaultRunGit;
  const runGh = deps.runGh || defaultRunGh;
  const notes = [];
  const result = {
    dir: null, created: false, gitInitialized: false, committed: false,
    remote: null, configUpdated: false, notes,
  };
  if (!workspace || !slug) throw new Error('scaffoldProject requires workspace and slug');

  const folderName = (dir || slug).replace(/[^a-zA-Z0-9._-]/g, '-');
  const target = resolve(workspace, folderName);
  result.dir = target;

  const exists = existsSync(target);
  const empty = exists ? readdirSync(target).length === 0 : true;
  const isRepo = exists && runGit(['rev-parse', '--is-inside-work-tree'], target).stdout === 'true';

  if (exists && !empty && !isRepo) {
    notes.push(`skipped: ${target} exists, is not empty, and is not a git repository — not touching it`);
    return result;
  }
  if (exists && !empty && isRepo) {
    notes.push(`skipped scaffold: ${target} is already a git repository`);
    return result;
  }

  if (!exists) {
    mkdirSync(target, { recursive: true });
    result.created = true;
  }

  const title = planTitle(planDoc) || slug;
  const overview = extractOverview(planDoc);
  const readme = [
    `# ${title}`,
    '',
    overview || '(See the build plan for details.)',
    '',
    '---',
    '',
    `Built from a [PlanForge](https://github.com/planforge) build plan${planPath ? `: \`${planPath}\`` : ''}.`,
    'The plan is the source of truth — its open decisions gate what gets built.',
    '',
  ].join('\n');
  writeFileSync(join(target, 'README.md'), readme);
  writeFileSync(join(target, '.gitignore'), GITIGNORE);

  const init = runGit(['init', '-b', 'main'], target);
  if (init.status !== 0) {
    notes.push(`git init failed: ${init.stderr || init.stdout}`);
    return result;
  }
  result.gitInitialized = true;
  runGit(['add', '-A'], target);
  const commit = runGit(['commit', '-m', `Scaffold ${title} from its build plan`], target);
  if (commit.status !== 0) {
    notes.push(`initial commit failed: ${commit.stderr || commit.stdout}`);
    return result;
  }
  result.committed = true;

  if (remote) {
    const spec = remote === true ? folderName : String(remote);
    const vis = isPublic ? '--public' : '--private';
    const create = runGh(['repo', 'create', spec, vis, '--source', target, '--remote', 'origin', '--push'], target);
    if (create.status !== 0) {
      notes.push(`gh repo create failed (project stays local-only): ${create.stderr || create.stdout}`);
      return result;
    }
    // Resolve the full owner/name from the origin URL (gh may have inferred the owner).
    const url = runGit(['remote', 'get-url', 'origin'], target).stdout;
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    result.remote = m ? m[1] : spec;
    notes.push(`remote created and pushed: ${result.remote}`);

    if (configPath && existsSync(configPath) && result.remote.includes('/')) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const repos = Array.isArray(config.repos) ? config.repos : [];
        if (!repos.includes(result.remote)) {
          config.repos = [...repos, result.remote];
          writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
          result.configUpdated = true;
          notes.push(`added ${result.remote} to "repos" in ${configPath}`);
        }
      } catch (e) {
        notes.push(`could not update ${configPath}: ${e.message}`);
      }
    }
  }
  return result;
}

// Commit a plan file into the plans directory's git repo, if there is one.
// Quietly a no-op when the plans dir is not inside a work tree.
export function commitPlanFile({ plansPath, filePath, message, deps = {} }) {
  const runGit = deps.runGit || defaultRunGit;
  if (runGit(['rev-parse', '--is-inside-work-tree'], plansPath).stdout !== 'true') {
    return { committed: false, reason: 'plans directory is not in a git repository' };
  }
  runGit(['add', filePath], plansPath);
  const commit = runGit(['commit', '-m', message], plansPath);
  if (commit.status !== 0) {
    const out = `${commit.stdout}\n${commit.stderr}`;
    if (/nothing to commit/i.test(out)) return { committed: false, reason: 'nothing to commit' };
    return { committed: false, reason: out.trim() };
  }
  return { committed: true };
}
