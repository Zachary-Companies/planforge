// Tests for ui/server.mjs — run with `node --test ui/`.
//
// Starts the server on an ephemeral port against a fixture workspace in a
// tmp dir. No real agents are spawned: POST /api/plans and POST /api/runs are
// exercised through the PLANFORGE_PLAN_CMD / PLANFORGE_RUN_CMD test seams
// (stub node scripts in the fixture workspace).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, parsePlanMarkdown, shellSplit, FALLBACK_QUESTIONS } from './server.mjs';

let ws; // fixture workspace
let srv; // { server, ctx, port, url, stop }
let base;

const FIXTURE_RUN_ID = '2026-07-01T12-00-00-000Z';

const PLAN_MD = `# Demo App

## 1. Overview

A demo application for exercising the plan parser.

## 2. Architecture

- Stack: per stack-preferences.json

## 3. Open decisions

### D1 — Storage engine

Status: Accepted — sqlite it is.

### D2 — Auth provider

Status: Proposed. Options: clerk, cognito.

- D3 — Hosting — Blocked on billing decision

## 4. Phases

### Phase 1 — Skeleton

- id: skeleton · paths: [src/] · status: pending

### Phase 2 — Features

- id: features · paths: [src/features/] · status: pending

## 5. Status ledger

- verified against abc123 2026-07-01
`;

const CANNED_EVENTS = [
  { t: 1751370000000, type: 'run-start', workers: 2, budget: 4, repos: ['acme/demo-app'] },
  { t: 1751370001000, type: 'plan-start', tag: 's001', want: 2 },
  { t: 1751370002000, type: 'plan-result', tag: 's001', status: 'queued', queued: 2, ids: ['slice-a', 'slice-b'] },
  { t: 1751370003000, type: 'launch', slot: 1, sliceId: 'slice-a', repo: 'acme/demo-app', title: 'First slice', kind: 'feature', index: 1, budget: 4 },
  { t: 1751370004000, type: 'stats', launched: 1, budget: 4, inFlight: 1, queued: 1, mergedPrs: 0, mergedSlices: 0, failed: 0, fixing: 0, fixQueued: 0, fixed: 0, dry: false, elapsedMs: 4000 },
  { t: 1751370005000, type: 'worker-done', slot: 1, sliceId: 'slice-a', ok: true, branch: 'worker-1/slice-a' },
  { t: 1751370006000, type: 'merge', label: 'merge pass 1', merged: ['acme/demo-app#12'] },
  { t: 1751370007000, type: 'run-done', launched: 2, mergedPrs: 2, failed: 0, fixed: 0 },
];

const PLAN_STUB = `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
console.log('interviewing your answers');
const i = args.indexOf('--answers');
const answers = i >= 0 ? JSON.parse(readFileSync(args[i + 1], 'utf8')) : {};
console.log('idea: ' + (answers.idea ?? 'none'));
mkdirSync('plans', { recursive: true });
writeFileSync('plans/streamed-idea-build-plan.md', '# Streamed Idea\\n\\n## 4. Phases\\n\\n### Phase 1 — Bootstrap\\n');
console.log('plan written');
`;

// like the real orchestrator: creates its own run dir under the workspace
const RUN_STUB = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.cwd(), '.planforge', 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'argv.json'), JSON.stringify(process.argv.slice(2)));
writeFileSync(join(dir, 'events.ndjson'),
  JSON.stringify({ t: Date.now(), type: 'run-start', workers: 1, budget: 2, repos: ['acme/demo-app'] }) + '\\n'
  + JSON.stringify({ t: Date.now(), type: 'run-done', launched: 2, mergedPrs: 2, failed: 0, fixed: 0 }) + '\\n');
setTimeout(() => {}, 300); // stay alive briefly so the server can record the pid
`;

before(async () => {
  ws = mkdtempSync(join(tmpdir(), 'planforge-ui-test-'));
  writeFileSync(join(ws, 'planforge.config.json'), JSON.stringify({
    workspace: '.',
    repos: ['acme/demo-app'],
    plansDir: 'plans',
    preferences: 'stack-preferences.json',
    workers: 2,
    maxSlices: 6,
  }, null, 2));
  mkdirSync(join(ws, 'plans'), { recursive: true });
  writeFileSync(join(ws, 'plans', 'demo-app-build-plan.md'), PLAN_MD);
  const runDir = join(ws, '.planforge', 'runs', FIXTURE_RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'events.ndjson'), `${CANNED_EVENTS.map((e) => JSON.stringify(e)).join('\n')}\n`);
  writeFileSync(join(ws, 'stub-plan-cmd.mjs'), PLAN_STUB);
  writeFileSync(join(ws, 'stub-run-cmd.mjs'), RUN_STUB);

  // force the built-in questions fallback regardless of what planning/ has
  process.env.PLANFORGE_QUESTIONS = join(ws, 'no-such-questions.json');

  srv = await startServer({ port: 0, configPath: join(ws, 'planforge.config.json') });
  base = srv.url;
});

after(async () => {
  delete process.env.PLANFORGE_QUESTIONS;
  delete process.env.PLANFORGE_PLAN_CMD;
  delete process.env.PLANFORGE_RUN_CMD;
  if (srv) await srv.stop();
  if (ws) rmSync(ws, { recursive: true, force: true });
});

/* ------------------------------------------------------------ unit-level */

test('shellSplit honors quotes', () => {
  assert.deepEqual(shellSplit('node script.mjs'), ['node', 'script.mjs']);
  assert.deepEqual(shellSplit('"/path with space/node" plan'), ['/path with space/node', 'plan']);
  assert.deepEqual(shellSplit("node '/a b/c.mjs' --x"), ['node', '/a b/c.mjs', '--x']);
});

test('parsePlanMarkdown counts phases and open decisions', () => {
  const p = parsePlanMarkdown(PLAN_MD);
  assert.equal(p.title, 'Demo App');
  assert.equal(p.phases, 2);
  assert.equal(p.openDecisions, 2); // D2 Proposed + D3 Blocked; D1 Accepted
});

/* ------------------------------------------------------------- /api/config */

test('GET /api/config returns config + preferences flag', async () => {
  const res = await fetch(`${base}/api/config`);
  assert.equal(res.status, 200);
  const cfg = await res.json();
  assert.equal(cfg.workspace, ws);
  assert.equal(cfg.plansDir, 'plans');
  assert.deepEqual(cfg.repos, ['acme/demo-app']);
  assert.equal(cfg.workers, 2);
  assert.equal(cfg.maxSlices, 6);
  assert.equal(cfg.hasPreferences, false);
  assert.equal(cfg.configPath, join(ws, 'planforge.config.json'));
});

/* ---------------------------------------------------------- /api/questions */

test('GET /api/questions serves the built-in fallback when the file is missing', async () => {
  const res = await fetch(`${base}/api/questions`);
  assert.equal(res.status, 200);
  const q = await res.json();
  assert.equal(q.fallback, true);
  // canonical questions.json shape: flat arrays with group/mapsTo
  assert.ok(Array.isArray(q.preferences) && q.preferences.length >= 10);
  assert.ok(q.preferences.every((p) => p.id && p.group && p.mapsTo && p.type));
  assert.ok(Array.isArray(q.interview) && q.interview.length >= 5);
  assert.equal(q.preferences.length, FALLBACK_QUESTIONS.preferences.length);
});

test('GET /api/questions serves planning/questions.json verbatim when present', async () => {
  const raw = '{"version":9,"preferences":[],"interview":[],"custom":"yes"}\n';
  const qPath = join(ws, 'custom-questions.json');
  writeFileSync(qPath, raw);
  process.env.PLANFORGE_QUESTIONS = qPath;
  try {
    const res = await fetch(`${base}/api/questions`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), raw); // byte-for-byte, no fallback flag injected
  } finally {
    process.env.PLANFORGE_QUESTIONS = join(ws, 'no-such-questions.json');
  }
});

/* -------------------------------------------------------------- /api/plans */

test('GET /api/plans parses slug/title/phases/openDecisions', async () => {
  const res = await fetch(`${base}/api/plans`);
  assert.equal(res.status, 200);
  const plans = await res.json();
  const plan = plans.find((p) => p.slug === 'demo-app');
  assert.ok(plan, 'demo-app plan listed');
  assert.equal(plan.title, 'Demo App');
  assert.equal(plan.phases, 2);
  assert.equal(plan.openDecisions, 2);
  assert.equal(plan.path, join(ws, 'plans', 'demo-app-build-plan.md'));
  assert.ok(typeof plan.mtime === 'number' && plan.mtime > 0);
});

test('GET /api/plans/:slug returns raw markdown; bad slugs rejected', async () => {
  const ok = await fetch(`${base}/api/plans/demo-app`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/markdown/);
  assert.equal(await ok.text(), PLAN_MD);

  const missing = await fetch(`${base}/api/plans/nope`);
  assert.equal(missing.status, 404);

  const traversal = await fetch(`${base}/api/plans/..%2F..%2Fetc`);
  assert.equal(traversal.status, 400);
});

test('static server refuses path traversal', async () => {
  const res = await fetch(`${base}/..%2Fserver.mjs`);
  assert.ok([400, 403, 404].includes(res.status), `got ${res.status}`);
  const root = await fetch(`${base}/`);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /PlanForge/);
});

/* -------------------------------------------------------- /api/preferences */

test('preferences round-trip: POST writes JSON + TECH-PREFERENCES.md, GET returns it', async () => {
  const before404 = await fetch(`${base}/api/preferences`);
  assert.equal(before404.status, 404);

  const prefs = {
    general: { languages: ['typescript'], packageManager: 'npm' },
    webApp: { framework: 'react', db: 'postgres' },
    freeform: 'prefer boring technology',
    somethingUnknown: { keep: 'me' }, // unknown top-level keys are preserved
  };
  const post = await fetch(`${base}/api/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prefs),
  });
  assert.equal(post.status, 200);
  const posted = await post.json();
  assert.equal(posted.ok, true);

  const get = await fetch(`${base}/api/preferences`);
  assert.equal(get.status, 200);
  const roundTripped = await get.json();
  assert.equal(roundTripped.version, 1);
  assert.deepEqual(roundTripped.general, prefs.general);
  assert.deepEqual(roundTripped.webApp, prefs.webApp);
  assert.equal(roundTripped.freeform, prefs.freeform);
  assert.deepEqual(roundTripped.somethingUnknown, prefs.somethingUnknown);

  const mdPath = join(ws, 'TECH-PREFERENCES.md');
  assert.ok(existsSync(mdPath), 'TECH-PREFERENCES.md written next to the JSON');
  const md = readFileSync(mdPath, 'utf8');
  assert.match(md, /# Tech preferences/);
  assert.match(md, /react/);
  assert.match(md, /prefer boring technology/);

  // config now reports preferences exist
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.hasPreferences, true);
});

test('POST /api/preferences rejects malformed bodies', async () => {
  const arr = await fetch(`${base}/api/preferences`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1,2,3]',
  });
  assert.equal(arr.status, 400);
  const wrongType = await fetch(`${base}/api/preferences`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ general: 'nope' }),
  });
  assert.equal(wrongType.status, 400);
  const notJson = await fetch(`${base}/api/preferences`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
  });
  assert.equal(notJson.status, 400);
});

/* ------------------------------------------------- POST /api/plans (seam) */

test('POST /api/plans spawns PLANFORGE_PLAN_CMD and streams NDJSON progress', async () => {
  process.env.PLANFORGE_PLAN_CMD = `"${process.execPath}" "${join(ws, 'stub-plan-cmd.mjs')}"`;
  try {
    const res = await fetch(`${base}/api/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: { idea: 'build a birdhouse app' } }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/x-ndjson/);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'start');
    const progress = lines.filter((l) => l.type === 'progress').map((l) => l.line);
    assert.ok(progress.includes('interviewing your answers'), `progress streamed: ${progress}`);
    assert.ok(progress.includes('idea: build a birdhouse app'), 'answers tmp file reached the CLI');
    const last = lines[lines.length - 1];
    assert.equal(last.type, 'done');
    assert.equal(last.ok, true);
    assert.equal(last.slug, 'streamed-idea'); // detected via plansDir diff
    assert.ok(existsSync(join(ws, 'plans', 'streamed-idea-build-plan.md')));
  } finally {
    delete process.env.PLANFORGE_PLAN_CMD;
  }
});

test('POST /api/plans validates the body', async () => {
  const res = await fetch(`${base}/api/plans`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nope: 1 }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/plans/:slug/revise streams via the same seam', async () => {
  process.env.PLANFORGE_PLAN_CMD = `"${process.execPath}" "${join(ws, 'stub-plan-cmd.mjs')}"`;
  try {
    const res = await fetch(`${base}/api/plans/demo-app/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: 'drop the mobile app' }),
    });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    assert.equal(last.type, 'done');
    assert.equal(last.slug, 'demo-app'); // revise keeps the known slug

    const missing = await fetch(`${base}/api/plans/nope/revise`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback: 'x' }),
    });
    assert.equal(missing.status, 404);
  } finally {
    delete process.env.PLANFORGE_PLAN_CMD;
  }
});

/* --------------------------------------------------------------- /api/runs */

test('GET /api/runs lists the canned run with last stats + run-done', async () => {
  const res = await fetch(`${base}/api/runs`);
  assert.equal(res.status, 200);
  const runs = await res.json();
  const run = runs.find((r) => r.id === FIXTURE_RUN_ID);
  assert.ok(run, 'canned run listed');
  assert.equal(run.status, 'done');
  assert.equal(run.events, CANNED_EVENTS.length);
  assert.equal(run.stats.launched, 1);
  assert.equal(run.stats.elapsedMs, 4000);
  assert.equal(run.runDone.mergedPrs, 2);
  assert.equal(run.runStart.workers, 2);
});

test('GET /api/runs/:id/events replays canned events over SSE, in order', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/runs/${FIXTURE_RUN_ID}/events`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  const deadline = Date.now() + 5000;
  while (events.length < CANNED_EVENTS.length && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop();
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      }
    }
  }
  controller.abort();
  assert.equal(events.length, CANNED_EVENTS.length);
  assert.deepEqual(events, CANNED_EVENTS); // byte-faithful replay, in order
});

test('GET /api/runs/:id/events 404s for unknown runs', async () => {
  const res = await fetch(`${base}/api/runs/2020-01-01T00-00-00-000Z/events`);
  assert.equal(res.status, 404);
});

test('POST /api/runs spawns PLANFORGE_RUN_CMD detached and adopts its run dir', async () => {
  process.env.PLANFORGE_RUN_CMD = `"${process.execPath}" "${join(ws, 'stub-run-cmd.mjs')}"`;
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workers: 1, maxSlices: 2, seedSlices: [{ id: 'seed-1', repo: 'acme/demo-app' }] }),
    });
    assert.equal(res.status, 200);
    const { ok, id, pid } = await res.json();
    assert.equal(ok, true);
    assert.ok(id && typeof id === 'string');
    assert.ok(Number.isInteger(pid));

    // the run id is the dir the (stub) orchestrator created itself
    const runDir = join(ws, '.planforge', 'runs', id);
    assert.ok(existsSync(join(runDir, 'events.ndjson')), 'stub run wrote events into the adopted dir');
    assert.ok(existsSync(join(runDir, 'pids.json')), 'pids tracked in the run dir');
    const pids = JSON.parse(readFileSync(join(runDir, 'pids.json'), 'utf8'));
    assert.equal(pids.pid, pid);

    const argv = JSON.parse(readFileSync(join(runDir, 'argv.json'), 'utf8'));
    assert.equal(argv[0], 'run');
    assert.ok(argv.includes('--config'), 'config path forwarded to the CLI');
    assert.ok(argv.includes('--workers') && argv.includes('1'));
    assert.ok(argv.includes('--max-slices') && argv.includes('2'));
    assert.ok(argv.includes('--seed-slices'), 'seed slices passed as a file');
    const seedFile = argv[argv.indexOf('--seed-slices') + 1];
    assert.deepEqual(JSON.parse(readFileSync(seedFile, 'utf8')), [{ id: 'seed-1', repo: 'acme/demo-app' }]);

    const list = await (await fetch(`${base}/api/runs`)).json();
    const entry = list.find((r) => r.id === id);
    assert.ok(entry, 'new run appears in the list');
    assert.equal(entry.runDone?.mergedPrs, 2);
  } finally {
    delete process.env.PLANFORGE_RUN_CMD;
  }
});

test('POST /api/runs validates numeric options', async () => {
  const res = await fetch(`${base}/api/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workers: -3 }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/runs/:id/stop reports when no live pid is tracked', async () => {
  const res = await fetch(`${base}/api/runs/${FIXTURE_RUN_ID}/stop`, { method: 'POST' });
  assert.equal(res.status, 409); // canned run has no pids.json
  const unknown = await fetch(`${base}/api/runs/2020-01-01T00-00-00-000Z/stop`, { method: 'POST' });
  assert.equal(unknown.status, 404);
});
