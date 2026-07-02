#!/usr/bin/env node
// PlanForge UI server — a zero-dependency local web server.
//
// Serves the single-page app in ui/app/ and a JSON API over the user's
// PlanForge workspace (the directory holding planforge.config.json):
//
//   GET  /api/config              loaded config + whether preferences exist
//   GET  /api/questions           planning/questions.json (or built-in fallback)
//   GET  /api/preferences         stack-preferences.json (404 if absent)
//   POST /api/preferences         validate + write JSON and TECH-PREFERENCES.md
//   GET  /api/plans               parsed list of <plansDir>/*-build-plan.md
//   GET  /api/plans/:slug         raw plan markdown
//   POST /api/plans               spawn `planforge plan --answers <tmp>` (NDJSON stream)
//   POST /api/plans/:slug/revise  spawn `planforge plan --revise <slug> --feedback <tmp>`
//   GET  /api/runs                run dirs under .planforge/runs/ + last stats
//   POST /api/runs                spawn `planforge run …` detached, return run id
//   GET  /api/runs/:id/events     SSE: replay events.ndjson from byte 0, then tail
//   POST /api/runs/:id/stop       SIGTERM the recorded pid
//
// Security: binds 127.0.0.1 only, rejects path traversal. No auth (local tool).
//
// Test seams (documented in ui/README.md):
//   PLANFORGE_PLAN_CMD   command spawned instead of `node bin/planforge.mjs` for plan/revise
//   PLANFORGE_RUN_CMD    command spawned instead of `node bin/planforge.mjs` for runs
//   PLANFORGE_QUESTIONS  alternate path for questions.json
//
// The spawned run child receives PLANFORGE_RUN_DIR (the run dir this server
// created) in its environment so events/pids land in a predictable place.

import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, renameSync, rmSync, statSync, watch, writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(UI_DIR);
const APP_DIR = join(UI_DIR, 'app');
const DEFAULT_PORT = 4173;

// ---------------------------------------------------------------------------
// Config loading — planforge.config.json (see docs/ARCHITECTURE.md §1)
// ---------------------------------------------------------------------------

const CONFIG_DEFAULTS = {
  workspace: '.',
  repos: [],
  plansDir: 'plans',
  preferences: 'stack-preferences.json',
  workers: 3,
  fixWorkers: 1,
  maxSlices: 12,
  providers: { builderPriority: ['codex', 'claude'], reviewerPriority: ['claude', 'codex'] },
  models: {},
};

function discoverConfigPath(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, 'planforge.config.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the config file + workspace. `explicitPath` (option or
 * PLANFORGE_CONFIG) may point at the file or at a directory containing it.
 * Without a config file the server still works: workspace = cwd, defaults.
 */
export function loadContext(explicitPath) {
  let configPath = null;
  const envPath = explicitPath ?? process.env.PLANFORGE_CONFIG ?? null;
  if (envPath) {
    let p = resolve(envPath);
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'planforge.config.json');
    if (!existsSync(p)) throw new Error(`PLANFORGE_CONFIG points at a missing file: ${p}`);
    configPath = p;
  } else {
    configPath = discoverConfigPath(process.cwd());
  }

  let raw = {};
  if (configPath) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot parse ${configPath}: ${err.message}`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${configPath} must contain a JSON object`);
    }
  }
  const config = { ...CONFIG_DEFAULTS, ...raw };
  const configDir = configPath ? dirname(configPath) : process.cwd();
  const workspace = resolve(configDir, config.workspace ?? '.');
  return {
    config,
    configPath,
    workspace,
    plansDir: resolve(workspace, config.plansDir ?? 'plans'),
    preferencesPath: resolve(workspace, config.preferences ?? 'stack-preferences.json'),
    runsRoot: join(workspace, '.planforge', 'runs'),
    tmpDir: join(workspace, '.planforge', 'tmp'),
  };
}

// ---------------------------------------------------------------------------
// Built-in question set — used when planning/questions.json is absent so the
// UI works standalone. Same shape planning/questions.json publishes:
//   preferences: flat array of { id, group, label, help, type, options, mapsTo }
//     (type: select | multiselect; "No preference" omits, "Other" = free text;
//      mapsTo is the dotted path into stack-preferences.json)
//   interview: flat array of { id, label, help, type, placeholder, options? }
// ---------------------------------------------------------------------------

export const FALLBACK_QUESTIONS = {
  version: 1,
  preferences: [
    { id: 'general-languages', group: 'general', label: 'Which programming languages do you prefer?',
      help: 'Pick any you like reading or already know a little.', type: 'multiselect',
      options: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Swift', 'Kotlin', 'No preference', 'Other'],
      mapsTo: 'general.languages' },
    { id: 'general-package-manager', group: 'general', label: 'Preferred package manager?', type: 'select',
      options: ['npm', 'pnpm', 'yarn', 'bun', 'uv', 'cargo', 'No preference', 'Other'],
      mapsTo: 'general.packageManager' },
    { id: 'general-license', group: 'general', label: 'Default license for your projects?', type: 'select',
      options: ['MIT', 'Apache-2.0', 'GPL-3.0', 'BSD-3-Clause', 'Proprietary', 'No preference'],
      mapsTo: 'general.license' },
    { id: 'general-testing', group: 'general', label: 'Preferred test runner?', type: 'select',
      options: ['vitest', 'jest', 'node:test', 'pytest', 'playwright', 'No preference', 'Other'],
      mapsTo: 'general.testing' },
    { id: 'general-ci', group: 'general', label: 'Continuous integration?', type: 'select',
      options: ['github-actions', 'gitlab-ci', 'circleci', 'none', 'No preference'],
      mapsTo: 'general.ci' },
    { id: 'web-framework', group: 'webApp', label: 'Web UI framework?', type: 'select',
      options: ['React', 'Vue', 'Svelte', 'Solid', 'htmx', 'Vanilla JS', 'No preference', 'Other'],
      mapsTo: 'webApp.framework' },
    { id: 'web-meta', group: 'webApp', label: 'Meta-framework / bundler?', type: 'select',
      options: ['Vite', 'Next.js', 'Nuxt', 'SvelteKit', 'Astro', 'None', 'No preference', 'Other'],
      mapsTo: 'webApp.meta' },
    { id: 'web-styling', group: 'webApp', label: 'Styling?', type: 'select',
      options: ['Tailwind', 'CSS modules', 'Vanilla CSS', 'Sass', 'No preference', 'Other'],
      mapsTo: 'webApp.styling' },
    { id: 'web-backend', group: 'webApp', label: 'Backend behind web apps?', type: 'select',
      options: ['Node + Express', 'Node + Fastify', 'Django', 'Rails', 'Go', 'Serverless', 'No preference', 'Other'],
      mapsTo: 'webApp.backend' },
    { id: 'web-db', group: 'webApp', label: 'Database?', type: 'select',
      options: ['Postgres', 'SQLite', 'MySQL', 'MongoDB', 'No preference', 'Other'],
      mapsTo: 'webApp.db' },
    { id: 'web-hosting', group: 'webApp', label: 'Hosting?', type: 'select',
      options: ['Vercel', 'Netlify', 'Fly.io', 'AWS', 'GCP', 'Self-hosted', 'No preference', 'Other'],
      mapsTo: 'webApp.hosting' },
    { id: 'mobile-framework', group: 'mobileApp', label: 'Mobile framework?', type: 'select',
      options: ['React Native (Expo)', 'Flutter', 'SwiftUI', 'Kotlin Compose', 'No preference', 'Other'],
      mapsTo: 'mobileApp.framework' },
    { id: 'mobile-backend', group: 'mobileApp', label: 'Backend for mobile apps?', type: 'select',
      options: ['Supabase', 'Firebase', 'Own API', 'No preference', 'Other'],
      mapsTo: 'mobileApp.backend' },
    { id: 'api-framework', group: 'api', label: 'API framework?', type: 'select',
      options: ['Fastify', 'Express', 'Hono', 'FastAPI', 'Go stdlib', 'Axum', 'No preference', 'Other'],
      mapsTo: 'api.framework' },
    { id: 'api-db', group: 'api', label: 'Database for services?', type: 'select',
      options: ['Postgres', 'SQLite', 'MySQL', 'MongoDB', 'Redis', 'No preference', 'Other'],
      mapsTo: 'api.db' },
    { id: 'api-style', group: 'api', label: 'API style?', type: 'select',
      options: ['REST', 'GraphQL', 'gRPC', 'tRPC', 'No preference'],
      mapsTo: 'api.style' },
    { id: 'cli-language', group: 'cli', label: 'Language for CLI tools?', type: 'select',
      options: ['TypeScript', 'Go', 'Rust', 'Python', 'No preference', 'Other'],
      mapsTo: 'cli.language' },
    { id: 'cli-distribution', group: 'cli', label: 'How should CLIs be distributed?', type: 'select',
      options: ['npm', 'Homebrew', 'Single binary', 'pipx', 'No preference'],
      mapsTo: 'cli.distribution' },
    { id: 'data-language', group: 'data', label: 'Language for data work?', type: 'select',
      options: ['Python', 'TypeScript', 'SQL', 'R', 'No preference', 'Other'],
      mapsTo: 'data.language' },
    { id: 'data-storage', group: 'data', label: 'Data storage?', type: 'select',
      options: ['Postgres', 'DuckDB', 'Parquet on S3', 'BigQuery', 'No preference', 'Other'],
      mapsTo: 'data.storage' },
  ],
  interview: [
    { id: 'idea', label: 'What are you building?', type: 'textarea', required: true,
      help: 'Describe it the way you would to a friend — what it does and why you want it to exist.',
      placeholder: 'A habit tracker that texts me when I break a streak.' },
    { id: 'users', label: 'Who will use it?', type: 'text',
      help: 'The actual people: just you, your family, a team at work, paying customers?',
      placeholder: 'Me and about ten friends' },
    { id: 'app-kinds', label: 'What kind of app is it?', type: 'multiselect',
      help: "Pick everything that applies. 'Not sure' is a fine answer.",
      options: ['Web app', 'Mobile app', 'API / backend service', 'Command-line tool', 'Data / analytics project', 'Not sure — recommend something'] },
    { id: 'must-haves', label: 'What are the 3–5 must-have features?', type: 'textarea',
      help: 'The things version 1 cannot ship without.',
      placeholder: '1. Shared lists  2. Invite by link  3. Works on phones' },
    { id: 'integrations', label: 'What does it need to connect to?', type: 'textarea',
      help: 'Other services, APIs, data sources — or nothing at all.',
      placeholder: 'Nothing external — maybe email for invites later' },
    { id: 'sign-in', label: 'Do people need to sign in?', type: 'select',
      help: "Sign-in adds real work — 'Not sure' lets the plan recommend the simplest thing that fits.",
      options: ['No sign-in needed', 'Simple email + password', 'Social sign-in (Google, Apple, GitHub)', 'Team or organization accounts', 'Not sure — recommend something'] },
    { id: 'scale', label: 'How many people will use it?', type: 'select',
      help: 'Small is a feature — it unlocks simpler, cheaper choices.',
      options: ['Just me', 'A small group (friends, family, my team)', 'Public — anyone on the internet', 'Not sure yet'] },
    { id: 'anything-else', label: 'Anything else the plan should know?', type: 'textarea',
      help: 'Constraints, deadlines, inspirations, strong opinions…' },
  ],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeName = (s) => typeof s === 'string' && SAFE_NAME.test(s) && !s.includes('..');

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 1);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req, res) {
  let text;
  try {
    text = await readBody(req);
  } catch (err) {
    json(res, err.statusCode || 400, { error: err.message });
    return undefined;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    json(res, 400, { error: 'request body is not valid JSON' });
    return undefined;
  }
}

/** Split a command string into argv, honoring single/double quotes. */
export function shellSplit(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (const ch of String(s)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; any = true; }
    else if (/\s/.test(ch)) {
      if (cur || any) { out.push(cur); cur = ''; any = false; }
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** Resolve the command to spawn: env override, else `node bin/planforge.mjs`. */
function resolveCliCommand(envName) {
  const override = process.env[envName];
  if (override && override.trim()) return { argv: shellSplit(override), source: envName };
  const bin = join(PKG_ROOT, 'bin', 'planforge.mjs');
  if (existsSync(bin)) return { argv: [process.execPath, bin], source: 'bin/planforge.mjs' };
  return null;
}

function onLines(stream, cb) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    for (const p of parts) if (p.trim()) cb(p);
  });
  stream.on('end', () => { if (buf.trim()) cb(buf.trim()); });
}

// ---------------------------------------------------------------------------
// Preferences — validation + TECH-PREFERENCES.md rendering
// ---------------------------------------------------------------------------

const BUILTIN_PREF_TYPES = {
  version: 'number',
  general: 'object',
  webApp: 'object',
  mobileApp: 'object',
  api: 'object',
  cli: 'object',
  data: 'object',
  freeform: 'string',
};

/** Known top-level key → expected type, from the schema file when present. */
function preferenceTypes() {
  const schemaPath = join(PKG_ROOT, 'planning', 'preferences-schema.json');
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    if (isPlainObject(schema.properties)) {
      const types = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        types[key] = isPlainObject(prop) && typeof prop.type === 'string' ? prop.type : 'any';
      }
      return types;
    }
  } catch { /* schema absent or unreadable — use the built-in shape */ }
  return BUILTIN_PREF_TYPES;
}

const jsType = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/**
 * Minimal shape check: body must be an object; known top-level keys must have
 * the expected type; unknown keys pass through untouched.
 */
export function validatePreferences(body) {
  if (!isPlainObject(body)) return { ok: false, error: 'preferences must be a JSON object' };
  const types = preferenceTypes();
  const problems = [];
  for (const [key, expected] of Object.entries(types)) {
    if (!(key in body) || expected === 'any') continue;
    const actual = jsType(body[key]);
    const okTypes = expected === 'integer' ? ['number'] : [expected];
    if (!okTypes.includes(actual)) problems.push(`"${key}" should be ${expected}, got ${actual}`);
  }
  if (problems.length) return { ok: false, error: `invalid preferences: ${problems.join('; ')}` };
  return { ok: true, value: { version: 1, ...body } };
}

const SECTION_TITLES = {
  general: 'General', webApp: 'Web apps', mobileApp: 'Mobile apps',
  api: 'APIs & services', cli: 'CLI tools', data: 'Data & ML',
};

const prettyValue = (v) => {
  if (Array.isArray(v)) return v.map((x) => `\`${String(x)}\``).join(', ');
  if (isPlainObject(v)) return `\`${JSON.stringify(v)}\``;
  return `\`${String(v)}\``;
};

export function renderPreferencesMarkdown(prefs) {
  const lines = [
    '# Tech preferences',
    '',
    '> Rendered by PlanForge from `stack-preferences.json` — the JSON file is',
    '> the machine-readable source of truth; this file is its readable mirror.',
    '> Planning and build agents honor these choices and record any deviation.',
    '',
  ];
  for (const [key, value] of Object.entries(prefs)) {
    if (key === 'version' || key === 'freeform') continue;
    if (!isPlainObject(value) || Object.keys(value).length === 0) continue;
    lines.push(`## ${SECTION_TITLES[key] ?? key}`, '');
    for (const [field, v] of Object.entries(value)) lines.push(`- **${field}**: ${prettyValue(v)}`);
    lines.push('');
  }
  if (typeof prefs.freeform === 'string' && prefs.freeform.trim()) {
    lines.push('## Anything else', '');
    for (const l of prefs.freeform.trim().split('\n')) lines.push(`> ${l}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Plans — cheap regex parse of <plansDir>/*-build-plan.md
// ---------------------------------------------------------------------------

function sliceSection(md, headingRe) {
  const lines = md.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]) && headingRe.test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

const DECISION_START = /^(?:#{1,6}\s+)?(?:[-*+]\s+)?(?:\*\*)?D\d+\b/;

export function parsePlanMarkdown(md) {
  const title = (md.match(/^#\s+(.+?)\s*$/m)?.[1] ?? '').replace(/\s#+$/, '').trim();
  const phases = (md.match(/^###\s+Phase\s+\d+/gim) ?? []).length;
  let openDecisions = 0;
  const section = sliceSection(md, /open decisions/i);
  if (section) {
    const lines = section.split('\n');
    const starts = [];
    for (let i = 0; i < lines.length; i += 1) if (DECISION_START.test(lines[i].trim())) starts.push(i);
    for (let s = 0; s < starts.length; s += 1) {
      const block = lines.slice(starts[s], starts[s + 1] ?? lines.length).join('\n');
      if (!/\bAccepted\b/i.test(block)) openDecisions += 1;
    }
  }
  return { title, phases, openDecisions };
}

function listPlans(ctx) {
  let names = [];
  try {
    names = readdirSync(ctx.plansDir).filter((n) => n.endsWith('-build-plan.md'));
  } catch { return []; }
  const out = [];
  for (const name of names) {
    const path = join(ctx.plansDir, name);
    let st; let md;
    try { st = statSync(path); md = readFileSync(path, 'utf8'); } catch { continue; }
    const slug = name.replace(/-build-plan\.md$/, '');
    const parsed = parsePlanMarkdown(md);
    out.push({
      slug,
      title: parsed.title || slug,
      path,
      phases: parsed.phases,
      openDecisions: parsed.openDecisions,
      mtime: st.mtimeMs,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function snapshotPlans(ctx) {
  const map = new Map();
  try {
    for (const n of readdirSync(ctx.plansDir)) {
      if (!n.endsWith('-build-plan.md')) continue;
      try { map.set(n, statSync(join(ctx.plansDir, n)).mtimeMs); } catch { /* raced */ }
    }
  } catch { /* plansDir absent — CLI creates it */ }
  return map;
}

function detectNewPlan(ctx, before) {
  const after = snapshotPlans(ctx);
  let best = null;
  for (const [name, mtime] of after) {
    const prev = before.get(name);
    if (prev !== undefined && prev >= mtime) continue; // unchanged
    if (!best || mtime > best.mtime) best = { name, mtime, isNew: prev === undefined };
  }
  if (!best) return null;
  return best.name.replace(/-build-plan\.md$/, '');
}

// ---------------------------------------------------------------------------
// Plan / revise spawning — NDJSON progress stream over a chunked response
// ---------------------------------------------------------------------------

function streamPlanCommand(req, res, ctx, args, { knownSlug = null } = {}) {
  const cmd = resolveCliCommand('PLANFORGE_PLAN_CMD');
  if (!cmd) {
    json(res, 501, {
      error: 'planforge CLI not found (bin/planforge.mjs is not built yet). '
        + 'Set PLANFORGE_PLAN_CMD to an alternate command, or build bin/.',
    });
    return;
  }
  const before = snapshotPlans(ctx);
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => { try { res.write(`${JSON.stringify(obj)}\n`); } catch { /* client gone */ } };
  send({ type: 'start', cmd: [...cmd.argv, ...args].join(' '), source: cmd.source });

  let child;
  try {
    child = spawn(cmd.argv[0], [...cmd.argv.slice(1), ...args], { cwd: ctx.workspace, env: { ...process.env } });
  } catch (err) {
    send({ type: 'error', ok: false, message: `failed to spawn: ${err.message}` });
    res.end();
    return;
  }

  let markerSlug = null;
  const errTail = [];
  onLines(child.stdout, (line) => {
    const m = line.match(/@plan-slug\s+(\S+)/); // optional CLI marker, preferred over dir-diff
    if (m && safeName(m[1])) markerSlug = m[1];
    send({ type: 'progress', line });
  });
  onLines(child.stderr, (line) => {
    errTail.push(line);
    if (errTail.length > 20) errTail.shift();
    send({ type: 'progress', stream: 'stderr', line });
  });

  const timeout = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 15 * 60 * 1000);
  child.on('error', (err) => {
    clearTimeout(timeout);
    send({ type: 'error', ok: false, message: `plan command failed to start: ${err.message}` });
    res.end();
  });
  child.on('close', (code) => {
    clearTimeout(timeout);
    if (code === 0) {
      const slug = knownSlug ?? markerSlug ?? detectNewPlan(ctx, before);
      send({
        type: 'done', ok: true, code: 0, slug: slug ?? null,
        ...(slug ? {} : { note: 'plan command succeeded but no new *-build-plan.md was detected' }),
      });
    } else {
      send({
        type: 'error', ok: false, code,
        message: errTail.slice(-5).join('\n') || `plan command exited with code ${code}`,
      });
    }
    res.end();
  });
  req.on('close', () => {
    if (child.exitCode === null && !child.killed) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  });
}

// ---------------------------------------------------------------------------
// Runs — list, start (detached), stop, SSE tail of events.ndjson
// ---------------------------------------------------------------------------

const runEventsCache = new Map(); // id -> { size, parsed }

function parseRunEvents(runDir, id) {
  const file = join(runDir, 'events.ndjson');
  let size = 0;
  try { size = statSync(file).size; } catch { return { count: 0, runStart: null, stats: null, runDone: null }; }
  const hit = runEventsCache.get(id);
  if (hit && hit.size === size) return hit.parsed;
  const parsed = { count: 0, runStart: null, stats: null, runDone: null };
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      parsed.count += 1;
      if (e.type === 'run-start') parsed.runStart = e;
      else if (e.type === 'stats') parsed.stats = e;
      else if (e.type === 'run-done') parsed.runDone = e;
    }
  } catch { /* partial file — return what we have */ }
  runEventsCache.set(id, { size, parsed });
  return parsed;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPids(runDir) {
  try { return JSON.parse(readFileSync(join(runDir, 'pids.json'), 'utf8')); } catch { return null; }
}

function listRuns(ctx) {
  let names = [];
  try {
    names = readdirSync(ctx.runsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
  names.sort().reverse(); // timestamp ids sort lexically
  const out = [];
  for (const id of names) {
    const runDir = join(ctx.runsRoot, id);
    const parsed = parseRunEvents(runDir, id);
    const pids = readPids(runDir);
    const alive = pids ? pidAlive(pids.pid) : false;
    let eventsMtime = 0;
    try { eventsMtime = statSync(join(runDir, 'events.ndjson')).mtimeMs; } catch { /* none yet */ }
    let status;
    if (parsed.runDone) status = 'done';
    else if (alive) status = 'running';
    else if (eventsMtime && Date.now() - eventsMtime < 20_000) status = 'running'; // externally-started tail
    else if (parsed.count > 0 || pids) status = 'stopped';
    else status = 'empty';
    out.push({
      id,
      status,
      events: parsed.count,
      runStart: parsed.runStart,
      stats: parsed.stats,
      runDone: parsed.runDone,
      pid: pids?.pid ?? null,
      pidAlive: alive,
      startedAt: pids?.startedAt ?? parsed.runStart?.t ?? null,
    });
    if (out.length >= 100) break;
  }
  return out;
}

/**
 * Start a run. The orchestrator creates its own run dir
 * (<workspace>/.planforge/runs/<timestamp>) when it boots, so we spawn the
 * CLI detached, watch the runs root for the new directory, then adopt it:
 * move the spawn log in as orchestrator.log and record the pid in pids.json.
 */
async function startRun(res, ctx, body) {
  const intOpt = (v, name) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error(`${name} must be a positive integer`), { statusCode: 400 });
    return n;
  };
  let workers; let maxSlices;
  try {
    workers = intOpt(body.workers, 'workers');
    maxSlices = intOpt(body.maxSlices, 'maxSlices');
  } catch (err) {
    json(res, err.statusCode, { error: err.message });
    return;
  }
  const PROVIDER_RE = /^[a-z][a-z0-9_-]*$/i;
  for (const role of ['builder', 'reviewer']) {
    const v = body[role];
    if (v !== undefined && v !== null && v !== '' && (typeof v !== 'string' || !PROVIDER_RE.test(v))) {
      json(res, 400, { error: `${role} must be a provider name (e.g. "claude", "codex", "glm")` });
      return;
    }
  }
  if (body.seedSlices !== undefined && !Array.isArray(body.seedSlices)) {
    json(res, 400, { error: 'seedSlices must be an array of slice objects' });
    return;
  }

  const cmd = resolveCliCommand('PLANFORGE_RUN_CMD');
  if (!cmd) {
    json(res, 501, {
      error: 'planforge CLI not found (bin/planforge.mjs is not built yet). '
        + 'Set PLANFORGE_RUN_CMD to an alternate command, or build bin/.',
    });
    return;
  }

  const args = ['run'];
  if (ctx.configPath) args.push('--config', ctx.configPath);
  if (workers !== undefined) args.push('--workers', String(workers));
  if (maxSlices !== undefined) args.push('--max-slices', String(maxSlices));
  if (body.builder) args.push('--builder', body.builder);
  if (body.reviewer) args.push('--reviewer', body.reviewer);
  mkdirSync(ctx.runsRoot, { recursive: true });
  if (Array.isArray(body.seedSlices) && body.seedSlices.length) {
    mkdirSync(ctx.tmpDir, { recursive: true });
    const seedFile = join(ctx.tmpDir, `seed-slices-${Date.now().toString(36)}.json`);
    writeFileSync(seedFile, `${JSON.stringify(body.seedSlices, null, 2)}\n`);
    args.push('--seed-slices', seedFile);
  }

  const listRunDirs = () => {
    try {
      return readdirSync(ctx.runsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { return []; }
  };
  const before = new Set(listRunDirs());

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const spawnLog = join(ctx.runsRoot, `.spawn-${stamp}.log`);
  let child;
  const logFd = openSync(spawnLog, 'a');
  try {
    child = spawn(cmd.argv[0], [...cmd.argv.slice(1), ...args], {
      cwd: ctx.workspace,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
  } catch (err) {
    closeSync(logFd);
    rmSync(spawnLog, { force: true });
    json(res, 500, { error: `failed to spawn run: ${err.message}` });
    return;
  }
  closeSync(logFd);
  child.unref();
  let exitCode = null;
  child.on('exit', (code) => { exitCode = code; });
  child.on('error', () => { exitCode = exitCode ?? -1; });

  // wait for the orchestrator's run dir to appear (usually well under 1s)
  const deadline = Date.now() + 8000;
  let id = null;
  while (Date.now() < deadline) {
    const fresh = listRunDirs().filter((n) => !before.has(n)).sort();
    if (fresh.length) { id = fresh[fresh.length - 1]; break; }
    if (exitCode !== null && exitCode !== 0) break;
    await new Promise((r) => { setTimeout(r, 120); });
  }

  const logTail = () => {
    try { return readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).slice(-12).join('\n'); } catch { return ''; }
  };
  if (!id && exitCode !== null && exitCode !== 0) {
    const tail = logTail();
    rmSync(spawnLog, { force: true });
    json(res, 502, { error: `run command exited with code ${exitCode} before creating a run dir`, log: tail });
    return;
  }
  if (!id) {
    // still starting after the wait window — adopt a placeholder dir so the
    // pid is tracked; the orchestrator's own dir will appear in /api/runs.
    id = `${stamp}-starting`;
    mkdirSync(join(ctx.runsRoot, id), { recursive: true });
  }
  const runDir = join(ctx.runsRoot, id);
  try { renameSync(spawnLog, join(runDir, 'orchestrator.log')); } catch { /* keep the spawn log */ }
  writeFileSync(join(runDir, 'pids.json'), `${JSON.stringify({
    pid: child.pid,
    startedAt: Date.now(),
    cmd: cmd.argv,
    args,
  }, null, 2)}\n`);
  json(res, 200, { ok: true, id, pid: child.pid });
}

function stopRun(res, ctx, id) {
  const runDir = join(ctx.runsRoot, id);
  if (!existsSync(runDir)) { json(res, 404, { error: `unknown run: ${id}` }); return; }
  const pids = readPids(runDir);
  if (!pids || !Number.isInteger(pids.pid)) {
    json(res, 409, { error: 'no pid recorded for this run (it may have been started outside the UI)' });
    return;
  }
  if (!pidAlive(pids.pid)) {
    json(res, 409, { error: 'process is not running', pid: pids.pid });
    return;
  }
  let killed = false;
  try { process.kill(-pids.pid, 'SIGTERM'); killed = true; } catch { /* no process group */ }
  if (!killed) {
    try { process.kill(pids.pid, 'SIGTERM'); killed = true; } catch { /* raced exit */ }
  }
  try {
    writeFileSync(join(runDir, 'pids.json'), `${JSON.stringify({ ...pids, stoppedAt: Date.now() }, null, 2)}\n`);
  } catch { /* best effort */ }
  json(res, 200, { ok: killed, pid: pids.pid });
}

/**
 * SSE tail of <runDir>/events.ndjson: replay from byte 0, then keep pushing
 * complete lines as they are appended. fs.watch on the run dir gives low
 * latency; a 500ms poll is the fallback (fs.watch is unreliable on some
 * filesystems). One SSE `data:` frame per NDJSON line, verbatim.
 */
function sseRunEvents(req, res, ctx, id, sseClients) {
  const runDir = join(ctx.runsRoot, id);
  if (!existsSync(runDir)) { json(res, 404, { error: `unknown run: ${id}` }); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  const file = join(runDir, 'events.ndjson');
  let offset = 0;
  let partial = '';
  const pump = () => {
    let st;
    try { st = statSync(file); } catch { return; }
    if (st.size < offset) { offset = 0; partial = ''; } // truncated/rotated — replay
    if (st.size === offset) return;
    let fd;
    try {
      fd = openSync(file, 'r');
      const len = st.size - offset;
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, offset);
      offset += read;
      partial += buf.toString('utf8', 0, read);
    } catch { return; } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    }
    const lines = partial.split('\n');
    partial = lines.pop();
    for (const line of lines) {
      if (line.trim()) { try { res.write(`data: ${line}\n\n`); } catch { /* client gone */ } }
    }
  };
  pump();

  let watcher = null;
  try { watcher = watch(runDir, pump); } catch { /* polling covers it */ }
  const poll = setInterval(pump, 500);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* client gone */ } }, 15_000);
  const cleanup = () => {
    clearInterval(poll);
    clearInterval(ping);
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
    sseClients.delete(cleanup);
  };
  sseClients.add(cleanup);
  req.on('close', cleanup);
}

// ---------------------------------------------------------------------------
// Static file serving — ui/app/, traversal-safe
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function serveStatic(res, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { res.writeHead(400).end('bad path'); return; }
  if (decoded === '/') decoded = '/index.html';
  if (decoded.includes('\0') || decoded.includes('..')) { res.writeHead(403).end('forbidden'); return; }
  const abs = resolve(APP_DIR, `.${decoded}`);
  if (abs !== APP_DIR && !abs.startsWith(APP_DIR + sep)) { res.writeHead(403).end('forbidden'); return; }
  let st;
  try { st = statSync(abs); } catch { res.writeHead(404).end('not found'); return; }
  if (!st.isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, {
    'Content-Type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  res.end(readFileSync(abs));
}

// ---------------------------------------------------------------------------
// HTTP server + routing
// ---------------------------------------------------------------------------

function questionsPathNow(options) {
  return options.questionsPath ?? process.env.PLANFORGE_QUESTIONS ?? join(PKG_ROOT, 'planning', 'questions.json');
}

export function createRequestHandler(ctx, options, sseClients) {
  const routes = [
    ['GET', /^\/api\/config$/, (req, res) => {
      json(res, 200, {
        ...ctx.config,
        workspace: ctx.workspace,
        configPath: ctx.configPath,
        hasPreferences: existsSync(ctx.preferencesPath),
        hasPlansDir: existsSync(ctx.plansDir),
        hasCli: existsSync(join(PKG_ROOT, 'bin', 'planforge.mjs'))
          || Boolean(process.env.PLANFORGE_PLAN_CMD || process.env.PLANFORGE_RUN_CMD),
      });
    }],

    ['GET', /^\/api\/questions$/, (req, res) => {
      const qPath = questionsPathNow(options);
      if (existsSync(qPath)) {
        try {
          const raw = readFileSync(qPath, 'utf8');
          JSON.parse(raw); // only served verbatim when it is valid JSON
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(raw);
          return;
        } catch { /* unparseable — fall through to the built-in set */ }
      }
      json(res, 200, { ...FALLBACK_QUESTIONS, fallback: true });
    }],

    ['GET', /^\/api\/providers$/, (req, res) => {
      // Provider availability + the roles they'd fill, via `planforge doctor
      // --json` (the UI never imports core code). PLANFORGE_DOCTOR_CMD is the
      // test seam, mirroring PLAN/RUN_CMD.
      const cmd = resolveCliCommand('PLANFORGE_DOCTOR_CMD');
      if (!cmd) { json(res, 501, { error: 'planforge CLI not found' }); return; }
      const args = [...cmd.argv.slice(1), 'doctor', '--json'];
      if (ctx.configPath) args.push('--config', ctx.configPath);
      execFile(cmd.argv[0], args, { cwd: ctx.workspace, timeout: 30000 }, (err, stdout) => {
        try {
          const report = JSON.parse(stdout);
          json(res, 200, { providers: report.providers ?? [], roles: report.roles ?? { builder: null, reviewer: null } });
        } catch {
          json(res, 502, { error: `doctor failed: ${err ? err.message : 'unparseable output'}` });
        }
      });
    }],

    ['GET', /^\/api\/preferences$/, (req, res) => {
      if (!existsSync(ctx.preferencesPath)) {
        json(res, 404, { error: `no preferences yet (${ctx.config.preferences} not found)` });
        return;
      }
      try {
        json(res, 200, JSON.parse(readFileSync(ctx.preferencesPath, 'utf8')));
      } catch (err) {
        json(res, 500, { error: `cannot parse ${ctx.preferencesPath}: ${err.message}` });
      }
    }],

    ['POST', /^\/api\/preferences$/, async (req, res) => {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      const checked = validatePreferences(body);
      if (!checked.ok) { json(res, 400, { error: checked.error }); return; }
      const mdPath = join(dirname(ctx.preferencesPath), 'TECH-PREFERENCES.md');
      mkdirSync(dirname(ctx.preferencesPath), { recursive: true });
      writeFileSync(ctx.preferencesPath, `${JSON.stringify(checked.value, null, 2)}\n`);
      writeFileSync(mdPath, renderPreferencesMarkdown(checked.value));
      json(res, 200, { ok: true, path: ctx.preferencesPath, mdPath, preferences: checked.value });
    }],

    ['GET', /^\/api\/plans$/, (req, res) => { json(res, 200, listPlans(ctx)); }],

    ['POST', /^\/api\/plans$/, async (req, res) => {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      if (!isPlainObject(body.answers)) { json(res, 400, { error: 'body.answers (object) is required' }); return; }
      mkdirSync(ctx.tmpDir, { recursive: true });
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const answersFile = join(ctx.tmpDir, `answers-${stamp}.json`);
      writeFileSync(answersFile, `${JSON.stringify(body.answers, null, 2)}\n`);
      const args = ['plan', '--answers', answersFile];
      if (ctx.configPath) args.push('--config', ctx.configPath);
      streamPlanCommand(req, res, ctx, args);
    }],

    ['GET', /^\/api\/plans\/([^/]+)$/, (req, res, m) => {
      const slug = decodeURIComponent(m[1]);
      if (!safeName(slug)) { json(res, 400, { error: 'invalid plan slug' }); return; }
      const path = join(ctx.plansDir, `${slug}-build-plan.md`);
      if (!existsSync(path)) { json(res, 404, { error: `unknown plan: ${slug}` }); return; }
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(path));
    }],

    ['POST', /^\/api\/plans\/([^/]+)\/revise$/, async (req, res, m) => {
      const slug = decodeURIComponent(m[1]);
      if (!safeName(slug)) { json(res, 400, { error: 'invalid plan slug' }); return; }
      if (!existsSync(join(ctx.plansDir, `${slug}-build-plan.md`))) {
        json(res, 404, { error: `unknown plan: ${slug}` });
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
      if (!feedback) { json(res, 400, { error: 'body.feedback (non-empty string) is required' }); return; }
      mkdirSync(ctx.tmpDir, { recursive: true });
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const feedbackFile = join(ctx.tmpDir, `feedback-${stamp}.md`);
      writeFileSync(feedbackFile, `${feedback}\n`);
      // --revise/--feedback are passed through even if the CLI grows them later;
      // a CLI that rejects them exits non-0 and the stream reports that clearly.
      const args = ['plan', '--revise', slug, '--feedback', feedbackFile];
      if (ctx.configPath) args.push('--config', ctx.configPath);
      streamPlanCommand(req, res, ctx, args, { knownSlug: slug });
    }],

    ['GET', /^\/api\/runs$/, (req, res) => { json(res, 200, listRuns(ctx)); }],

    ['POST', /^\/api\/runs$/, async (req, res) => {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      await startRun(res, ctx, body);
    }],

    ['GET', /^\/api\/runs\/([^/]+)\/events$/, (req, res, m) => {
      const id = decodeURIComponent(m[1]);
      if (!safeName(id)) { json(res, 400, { error: 'invalid run id' }); return; }
      sseRunEvents(req, res, ctx, id, sseClients);
    }],

    ['POST', /^\/api\/runs\/([^/]+)\/stop$/, (req, res, m) => {
      const id = decodeURIComponent(m[1]);
      if (!safeName(id)) { json(res, 400, { error: 'invalid run id' }); return; }
      stopRun(res, ctx, id);
    }],
  ];

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      for (const [method, re, handler] of routes) {
        const m = path.match(re);
        if (!m) continue;
        if (req.method !== method) {
          // another method may match the same path (e.g. GET+POST /api/plans)
          const alt = routes.find(([mth, r]) => mth === req.method && r.test(path));
          if (!alt) { json(res, 405, { error: `method ${req.method} not allowed on ${path}` }); return; }
          await alt[2](req, res, path.match(alt[1]));
          return;
        }
        await handler(req, res, m);
        return;
      }
      if (path.startsWith('/api/')) { json(res, 404, { error: `no such endpoint: ${path}` }); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
      serveStatic(res, path);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: err.message ?? String(err) });
      else { try { res.end(); } catch { /* already gone */ } }
    }
  };
}

/**
 * Start the UI server. Options (all optional):
 *   port          listen port (default PLANFORGE_PORT or 4173; 0 = ephemeral)
 *   configPath    explicit planforge.config.json (default PLANFORGE_CONFIG or walk-up)
 *   questionsPath explicit questions.json (default PLANFORGE_QUESTIONS or planning/)
 * Resolves to { server, ctx, port, url, stop } — `stop()` closes SSE clients
 * and the server.
 */
export function startServer(options = {}) {
  const ctx = loadContext(options.configPath);
  const sseClients = new Set();
  const server = createServer(createRequestHandler(ctx, options, sseClients));
  const port = options.port ?? (process.env.PLANFORGE_PORT ? Number(process.env.PLANFORGE_PORT) : DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.reject(new Error(`invalid port: ${port}`));
  }
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      const stop = () => new Promise((done) => {
        for (const cleanup of [...sseClients]) cleanup();
        server.closeAllConnections();
        server.close(() => done());
      });
      resolvePromise({ server, ctx, port: actual, url: `http://127.0.0.1:${actual}`, stop });
    });
  });
}

// Run directly: `node ui/server.mjs`
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  startServer().then(({ ctx, url }) => {
    console.log(`PlanForge UI: ${url}`);
    console.log(ctx.configPath
      ? `Workspace: ${ctx.workspace} (config: ${ctx.configPath})`
      : `Workspace: ${ctx.workspace} (no planforge.config.json found — using defaults)`);
  }).catch((err) => {
    console.error(`planforge-ui: ${err.message}`);
    process.exit(1);
  });
}
