// Deterministic tests of the orchestrator: runPool's scheduler with injected
// fake agents (no real agents, git, or gh — just the control-flow loop), the
// planner-validation path, the auto-provider failover, and the event emitter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runPool,
  validateSlices,
  pathsOverlap,
  extractJsonArray,
  globToRegex,
  buildPlannerPrompt,
  createAutoProvider,
  createEmitter,
  runOrchestrator,
} from './orchestrator.mjs';
import { loadConfig } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POOL = { timeout: 30000 };

function makeArgs(over = {}) {
  return {
    workers: 3,
    repos: ['o/a', 'o/b', 'o/c'],
    workspace: '/tmp/pf-test-ws',
    plansPath: '/tmp/pf-test-ws/plans',
    reconcile: false,
    reconcileEvery: 0,
    refactorEvery: 0,
    depsLink: false,
    ...over,
  };
}
const roles = { builder: 'Codex', reviewer: 'Claude' };

// ---- pool invariant: runs to budget, never exceeds K, exclusion is wired ----
test('budget + concurrency + in-flight exclusion', POOL, async () => {
  const K = 3, budget = 17;
  const building = new Set(); // slice ids currently in a fake worker
  let active = 0, maxActive = 0, launched = 0;
  let exclusionWired = true;

  const planSome = async ({ k, inFlight, refactorRound }) => {
    await sleep(1);
    // Every currently-building slice must be in the exclusion list handed to us.
    const inFlightIds = new Set(inFlight.map((s) => s.id));
    for (const id of building) if (!inFlightIds.has(id)) exclusionWired = false;
    const slices = Array.from({ length: k }, () => {
      launched += 1;
      return { id: `sl-${launched}`, repo: 'o/a', title: `t${launched}`, paths: [`src/f${launched}.ts`], kind: 'feature' };
    });
    if (refactorRound && slices.length) slices[0].kind = 'refactor';
    return { slices, empty: false };
  };
  const runWorker = async ({ slice }) => {
    building.add(slice.id);
    active += 1; maxActive = Math.max(maxActive, active);
    await sleep(3 + (Number(slice.id.split('-')[1]) * 7) % 17); // varied, deterministic
    active -= 1; building.delete(slice.id);
    return { slice, ok: true };
  };

  await runPool({
    args: makeArgs({ workers: K }), runDir: '/tmp/pf-run1', roles, sliceBudget: budget,
    deps: { planSome, runWorker, mergeWorkerPrs: () => ['o/a#1'], runReconcile: async () => {} },
  });

  assert.equal(launched, budget, 'launched exactly the slice budget');
  assert.ok(maxActive <= K, 'never exceeded K concurrent workers');
  assert.equal(maxActive, K, 'actually used the parallelism');
  assert.ok(exclusionWired, 'in-flight exclusion handed to every planner call');
});

// ---- pool invariant: dry plan stops the pool without hanging ----
test('dry-out: an empty plan against an idle pool drains and stops', POOL, async () => {
  let launched = 0;
  const planSome = async ({ k }) => {
    await sleep(1);
    if (launched >= 5) return { slices: [], empty: true }; // go dry after 5
    const slices = Array.from({ length: Math.min(k, 5 - launched) }, () => {
      launched += 1;
      return { id: `d-${launched}`, repo: 'o/b', title: 't', paths: [`p${launched}.ts`], kind: 'feature' };
    });
    return { slices, empty: false };
  };
  const runWorker = async ({ slice }) => { await sleep(2); return { slice, ok: true }; };
  await runPool({
    args: makeArgs(), runDir: '/tmp/pf-run2', roles, sliceBudget: 999,
    deps: { planSome, runWorker, mergeWorkerPrs: () => [], runReconcile: async () => {} },
  });
  assert.equal(launched, 5, 'stops at the dry point well under budget');
});

// ---- refactor cadence + never two refactors at once ----
test('refactor cadence', POOL, async () => {
  const K = 2, every = 2, budget = 16; // density: 1 refactor per every*K = 4 launched
  let launched = 0, refactors = 0, refConcurrent = 0, maxRef = 0, refRequested = 0;
  const planSome = async ({ k, refactorRound }) => {
    await sleep(1);
    if (refactorRound) refRequested += 1;
    const slices = Array.from({ length: k }, () => {
      launched += 1;
      return { id: `r-${launched}`, repo: 'o/c', title: 't', paths: [`q${launched}.ts`], kind: 'feature' };
    });
    if (refactorRound && slices.length) slices[0].kind = 'refactor';
    return { slices, empty: false };
  };
  const runWorker = async ({ slice }) => {
    if (slice.kind === 'refactor') { refactors += 1; refConcurrent += 1; maxRef = Math.max(maxRef, refConcurrent); }
    await sleep(3 + (launched * 5) % 11);
    if (slice.kind === 'refactor') refConcurrent -= 1;
    return { slice, ok: true };
  };
  await runPool({
    args: makeArgs({ workers: K, refactorEvery: every }), runDir: '/tmp/pf-run3', roles, sliceBudget: budget,
    deps: { planSome, runWorker, mergeWorkerPrs: () => ['o/c#9'], runReconcile: async () => {} },
  });
  // With the K-seed the first refactor lands ~(every-1)*K in, so density ≈ budget/per.
  const per = every * K;
  const expected = Math.floor(budget / per); // 4 for budget 16
  assert.ok(refactors >= expected - 1 && refactors <= expected + 1,
    `forced a sane number of refactors (got ${refactors}, expected ~${expected})`);
  assert.equal(refactors, refRequested, 'every refactor request produced exactly one refactor slice');
  assert.ok(maxRef <= 1, 'never two refactors building at once');
});

// ---- acceptance evals: run for this-run's built slices, gate run-done ----
test('acceptance evals run for built slices and surface failures in run-done', POOL, async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-evalrun-'));
  mkdirSync(join(ws, 'plans'), { recursive: true });
  writeFileSync(join(ws, 'plans', 'a-build-plan.md'), [
    '# A — build plan', '## 4. Phases', '### Phase 1',
    '- **feat-good — Good**\n  - status: pending\n  - acceptance: it works',
    '- **feat-bad — Bad**\n  - status: pending\n  - acceptance: it works\n  - acceptance: edge case',
  ].join('\n'));

  let launched = 0;
  const planSome = async ({ k }) => {
    await sleep(1);
    if (launched >= 3) return { slices: [], empty: true };
    // feat-good/feat-bad are in the plan; request-fix is a planner-derived
    // user request that is NOT in the plan (the "planforge said it succeeded"
    // hole: these must be evaluated too, via synthesized criteria).
    const all = [
      { id: 'feat-good', repo: 'o/a', title: 'feat-good', paths: ['src/feat-good.ts'], kind: 'feature' },
      { id: 'feat-bad', repo: 'o/a', title: 'feat-bad', paths: ['src/feat-bad.ts'], kind: 'feature' },
      { id: 'request-fix', repo: 'o/a', title: 'Fix white images', paths: ['src/nav.ts'], kind: 'feature', notes: 'user: images turn white when navigating', fromRequest: 'req-1' },
    ];
    const slices = all.slice(launched, launched + k);
    launched += slices.length;
    return { slices, empty: false };
  };
  const runWorker = async ({ slice }) => { await sleep(1); return { slice, ok: true }; };

  // injected evaluator: pass feat-good and request-fix, fail feat-bad
  const evaluated = [];
  const evalRunner = async (slice, { verdictFile }) => {
    evaluated.push(slice.id);
    const pass = slice.id !== 'feat-bad';
    writeFileSync(verdictFile, JSON.stringify({
      sliceId: slice.id,
      status: pass ? 'pass' : 'fail',
      criteria: slice.criteria.map((text, i) => ({ text, met: pass || i === 0, evidence: 'ran' })),
    }));
    return { code: 0, stdout: '', stderr: '' };
  };

  const events = [];
  const runDir = mkdtempSync(join(tmpdir(), 'pf-evalrun-dir-'));
  await runPool({
    args: makeArgs({ workers: 2, repos: ['o/a'], workspace: ws, plansPath: join(ws, 'plans') }),
    runDir, roles, sliceBudget: 999,
    emit: (t, d) => events.push([t, d]),
    deps: { planSome, runWorker, mergeWorkerPrs: () => ['o/a#1'], runReconcile: async () => {}, evalRunner },
  });

  const started = events.find(([t]) => t === 'evals-start');
  assert.ok(started, 'evals-start emitted for the repo');
  assert.equal(started[1].slices, 3, 'plan slices AND the ad-hoc request slice are evaluated');
  assert.ok(evaluated.includes('request-fix'), 'the not-in-plan request slice went through the eval gate');
  const done = events.find(([t]) => t === 'evals-done');
  assert.equal(done[1].passed, 2);
  assert.equal(done[1].failed, 1);
  assert.deepEqual(done[1].failedSlices, ['feat-bad']);
  const runDone = events.find(([t]) => t === 'run-done');
  assert.equal(runDone[1].evalsFailed, 1, 'run-done carries the unverified count');
  // per-slice verdict files were written under the run dir
  assert.ok(existsSync(join(runDir, 'evals', 'a', 'feat-good.verdict.json')));
  assert.ok(existsSync(join(runDir, 'evals', 'a', 'request-fix.verdict.json')));
  rmSync(ws, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
});

test('--no-evals (args.evals=false) skips the acceptance eval phase', POOL, async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-noeval-'));
  mkdirSync(join(ws, 'plans'), { recursive: true });
  writeFileSync(join(ws, 'plans', 'a-build-plan.md'), '# A\n## 4. Phases\n- **feat-x — X**\n  - acceptance: it works');
  let launched = 0;
  const planSome = async ({ k }) => { await sleep(1); if (launched >= 1) return { slices: [], empty: true }; launched += 1; return { slices: [{ id: 'feat-x', repo: 'o/a', title: 'X', paths: ['src/x.ts'], kind: 'feature' }], empty: false }; };
  let evalCalled = false;
  const events = [];
  await runPool({
    args: makeArgs({ workers: 1, repos: ['o/a'], workspace: ws, plansPath: join(ws, 'plans'), evals: false }),
    runDir: mkdtempSync(join(tmpdir(), 'pf-noeval-dir-')), roles, sliceBudget: 999,
    emit: (t, d) => events.push([t, d]),
    deps: { planSome, runWorker: async ({ slice }) => ({ slice, ok: true }), mergeWorkerPrs: () => ['o/a#1'], runReconcile: async () => {}, evalRunner: async () => { evalCalled = true; return { code: 0 }; } },
  });
  assert.equal(evalCalled, false, 'evaluator never invoked when evals are off');
  assert.ok(!events.some(([t]) => t === 'evals-start'), 'no evals phase');
  rmSync(ws, { recursive: true, force: true });
});

// ---- deploy-after-run: ships on a clean run, refuses on a failed one ----
test('deploy phase ships a clean run and skips a run with failed evals', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-deploy-'));
  // a repo checkout with a deploy target so a publish action is detected
  const repoDir = join(ws, 'demo');
  mkdirSync(join(repoDir, 'node_modules'), { recursive: true });
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
  writeFileSync(join(repoDir, 'firebase.json'), '{}');

  const planSome = (() => { let n = 0; return async ({ k }) => { await sleep(1); if (n >= 1) return { slices: [], empty: true }; n += 1; return { slices: [{ id: 'feat', repo: 'o/demo', title: 'feat', paths: ['src/feat.ts'], kind: 'feature' }], empty: false }; }; })();
  const runWorker = async ({ slice }) => { await sleep(1); return { slice, ok: true }; };

  // ---- clean run: eval passes → deploy runs ----
  const deployed = [];
  const deployProject = async (project) => { deployed.push(project); return { code: 0 }; };
  let events = [];
  await runPool({
    args: makeArgs({ workers: 1, repos: ['o/demo'], workspace: ws, plansPath: join(ws, 'plans'), deployFlag: true }),
    runDir: mkdtempSync(join(tmpdir(), 'pf-deploy-dir-')), roles, sliceBudget: 999,
    emit: (t, d) => events.push([t, d]),
    deps: {
      planSome, runWorker, mergeWorkerPrs: () => ['o/demo#1'], runReconcile: async () => {}, runVerify: () => ({ ok: true }),
      evalRunner: async (slice, { verdictFile }) => { writeFileSync(verdictFile, JSON.stringify({ sliceId: slice.id, status: 'pass', criteria: slice.criteria.map((text) => ({ text, met: true, evidence: 'ran' })) })); return { code: 0 }; },
      deployProject,
    },
  });
  assert.deepEqual(deployed, ['demo'], 'a clean run deployed the touched project');
  assert.ok(events.some(([t, d]) => t === 'deploy-result' && d.ok), 'deploy-result ok emitted');
  assert.equal(events.find(([t]) => t === 'run-done')[1].deployed, 1);

  // ---- failed evals: deploy is skipped, nothing shipped ----
  const deployed2 = [];
  events = [];
  const planSome2 = (() => { let n = 0; return async ({ k }) => { await sleep(1); if (n >= 1) return { slices: [], empty: true }; n += 1; return { slices: [{ id: 'feat2', repo: 'o/demo', title: 'feat2', paths: ['src/feat2.ts'], kind: 'feature' }], empty: false }; }; })();
  await runPool({
    args: makeArgs({ workers: 1, repos: ['o/demo'], workspace: ws, plansPath: join(ws, 'plans'), deployFlag: true }),
    runDir: mkdtempSync(join(tmpdir(), 'pf-deploy-dir2-')), roles, sliceBudget: 999,
    emit: (t, d) => events.push([t, d]),
    deps: {
      planSome: planSome2, runWorker, mergeWorkerPrs: () => ['o/demo#2'], runReconcile: async () => {}, runVerify: () => ({ ok: true }),
      evalRunner: async (slice, { verdictFile }) => { writeFileSync(verdictFile, JSON.stringify({ sliceId: slice.id, status: 'fail', criteria: slice.criteria.map((text) => ({ text, met: false, evidence: 'broken' })) })); return { code: 0 }; },
      deployProject: async (p) => { deployed2.push(p); return { code: 0 }; },
    },
  });
  assert.deepEqual(deployed2, [], 'a run with a failed eval did NOT deploy');
  assert.ok(events.some(([t, d]) => t === 'deploy-skip' && /eval/.test(d.reason)), 'deploy-skip cites the failed evals');
  rmSync(ws, { recursive: true, force: true });
});

// ---- live request inbox: a request dropped mid-run gets planned+built ----
test('a request added to the run inbox mid-run is picked up without a restart', POOL, async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'pf-inbox-'));
  const built = [];
  let sawInitial = false;

  // Planner: builds the one seeded slice, then goes dry — UNTIL a request shows
  // up in pendingRequests, which it turns into a slice tagged fromRequest.
  const planSome = async ({ k, userRequests }) => {
    await sleep(1);
    if (!sawInitial) {
      sawInitial = true;
      return { slices: [{ id: 'seed', repo: 'o/a', title: 'seed', paths: ['src/seed.ts'], kind: 'feature' }], empty: false };
    }
    if (userRequests && userRequests.length) {
      const r = userRequests[0];
      return { slices: [{ id: `req-slice-${r.id}`, repo: 'o/a', title: r.text, paths: [`src/${r.id}.ts`], kind: 'feature', fromRequest: r.id }], empty: false };
    }
    return { slices: [], empty: true }; // dry until a request arrives
  };
  const runWorker = async ({ slice }) => {
    built.push(slice.id);
    // Once the seed has been built and the pool is idling dry, drop a request
    // into the inbox — exactly what the server does when you "add a feature".
    if (slice.id === 'seed') {
      writeFileSync(join(runDir, 'inbox', 'r1.json'), JSON.stringify([{ id: 'live-1', repo: 'o/a', text: 'add a dark mode toggle' }]));
    }
    await sleep(1);
    return { slice, ok: true };
  };

  const events = [];
  await runPool({
    args: makeArgs({ workers: 1, repos: ['o/a'], workspace: '/tmp/pf-inbox-ws', plansPath: '/tmp/pf-inbox-ws/plans', evals: false }),
    runDir, roles, sliceBudget: 1, // deliberately tiny: the added request must raise it
    emit: (t, d) => events.push([t, d]),
    deps: { planSome, runWorker, mergeWorkerPrs: () => ['o/a#1'], runReconcile: async () => {} },
  });

  assert.ok(built.includes('seed'), 'the seeded slice built');
  assert.ok(built.includes('req-slice-live-1'), 'the mid-run request was planned and built without a restart');
  const added = events.find(([t]) => t === 'request-added');
  assert.ok(added, 'request-added event emitted');
  assert.equal(added[1].request, 'live-1');
  assert.ok(events.some(([t, d]) => t === 'request-planned' && d.request === 'live-1'), 'the added request was marked planned');
  rmSync(runDir, { recursive: true, force: true });
});

// ---- reconcile cadence fires and respects the plans-repo-busy guard ----
test('reconcile cadence + plans-busy guard', POOL, async () => {
  const K = 2, every = 1, budget = 8; // reconcile every every*K = 2 merged slices
  let reconciles = 0, reconcileWhilePlansBusy = 0;
  let plansRepoBuilding = 0;
  let count = 0;
  // The plans dir lives INSIDE the o/plansrepo checkout, so a building o/plansrepo
  // slice must block a concurrent reconcile pass.
  const args = makeArgs({
    workers: K, reconcile: true, reconcileEvery: every,
    repos: ['o/a', 'o/plansrepo'],
    workspace: '/tmp/pf-test-ws',
    plansPath: '/tmp/pf-test-ws/plansrepo/plans',
  });
  const planSome = async ({ k }) => {
    await sleep(1);
    const slices = Array.from({ length: k }, () => {
      count += 1;
      // alternate a plans-repo slice in to exercise the guard
      const repo = count % 3 === 0 ? 'o/plansrepo' : 'o/a';
      return { id: `m-${count}`, repo, title: 't', paths: [`z${count}.ts`], kind: 'feature' };
    });
    return { slices, empty: false };
  };
  const runWorker = async ({ slice }) => {
    const isPlans = slice.repo === 'o/plansrepo';
    if (isPlans) plansRepoBuilding += 1;
    await sleep(4);
    if (isPlans) plansRepoBuilding -= 1;
    return { slice, ok: true };
  };
  const runReconcile = async () => {
    reconciles += 1;
    if (plansRepoBuilding > 0) reconcileWhilePlansBusy += 1;
    await sleep(2);
  };
  await runPool({
    args, runDir: '/tmp/pf-run4', roles, sliceBudget: budget,
    deps: { planSome, runWorker, mergeWorkerPrs: () => ['o/a#1'], runReconcile },
  });
  assert.ok(reconciles >= 2, `mid-run + final reconciles fired (got ${reconciles})`);
  assert.equal(reconcileWhilePlansBusy, 0, 'never reconciled while a plans-repo slice was building');
});

// ---- chaos: failing workers, deferred merges, under-filling planner ----
test('chaos: failures + deferred merges + under-filled plans still drain', POOL, async () => {
  const K = 4, budget = 40;
  let launched = 0, active = 0, maxActive = 0, finished = 0;
  const planSome = async ({ k }) => {
    await sleep(1 + (launched % 3));
    // Under-fill sometimes: return fewer than asked, occasionally just 1.
    const give = Math.max(1, k - (launched % 2));
    const slices = Array.from({ length: give }, () => {
      launched += 1;
      return { id: `c-${launched}`, repo: `o/${'abcd'[launched % 4]}`, title: 't', paths: [`p${launched}.ts`], kind: 'feature' };
    });
    return { slices, empty: false };
  };
  const runWorker = async ({ slice }) => {
    active += 1; maxActive = Math.max(maxActive, active);
    await sleep(2 + (Number(slice.id.split('-')[1]) * 13) % 23);
    active -= 1; finished += 1;
    return { slice, ok: Number(slice.id.split('-')[1]) % 4 !== 0 }; // ~1/4 fail
  };
  // Deferred: merge returns [] half the time (PR not clean yet).
  const mergeWorkerPrs = (repos) => (launched % 2 === 0 ? [] : [`${repos[0]}#${launched}`]);
  await runPool({
    args: makeArgs({ workers: K, repos: ['o/a', 'o/b', 'o/c', 'o/d'] }), runDir: '/tmp/pf-run5', roles, sliceBudget: budget,
    deps: { planSome, runWorker, mergeWorkerPrs, runReconcile: async () => {} },
  });
  assert.equal(launched, budget, 'launched exactly budget');
  assert.equal(finished, budget, 'every launched worker finished (drained)');
  assert.ok(maxActive <= K, 'never exceeded K');
});

// ---- over-provisioned pool: idle workers wait through saturation ----
test('over-provisioned pool waits out saturation and drains the backlog', POOL, async () => {
  const K = 20, cap = 3, backlog = 25;
  let remaining = backlog, launched = 0, active = 0, maxActive = 0;
  let sawSaturation = false;
  // The planner only ever offers up to (cap - currently in flight/queued) slices,
  // modelling a backlog where everything conflicts beyond `cap` at a time.
  const planSome = async ({ k, inFlight }) => {
    await sleep(2);
    const busy = inFlight.length; // in flight + queued, per runPool's exclusion set
    const n = Math.max(0, Math.min(k, cap - busy, remaining));
    if (n === 0) { if (busy > 0) sawSaturation = true; return { slices: [], empty: remaining === 0 && busy === 0 }; }
    const slices = Array.from({ length: n }, () => {
      launched += 1; remaining -= 1;
      return { id: `op-${launched}`, repo: 'o/a', title: 't', paths: [`f${launched}.ts`], kind: 'feature' };
    });
    return { slices, empty: false };
  };
  const runWorker = async ({ slice }) => {
    active += 1; maxActive = Math.max(maxActive, active);
    await sleep(3 + (Number(slice.id.split('-')[1]) * 11) % 19);
    active -= 1;
    return { slice, ok: true };
  };
  await runPool({
    args: makeArgs({ workers: K }), runDir: '/tmp/pf-run6', roles, sliceBudget: 200,
    deps: { planSome, runWorker, mergeWorkerPrs: () => ['o/a#1'], runReconcile: async () => {} },
  });
  assert.equal(launched, backlog, 'ran the ENTIRE backlog (no premature dry)');
  assert.ok(maxActive <= cap, 'respected the concurrency cap');
  assert.equal(maxActive, cap, 'actually reached the cap (used available parallelism)');
  assert.ok(sawSaturation, 'idle slots waited through saturation, did not shut down');
});

// ---- fix lane: interleaved with builds, DRAFT routing, caps, auto-merge ----
test('fix lane drains a failing backlog alongside builds', POOL, async () => {
  const K = 6, fixCap = 2, budget = 8, backlog = 10;
  const failing = new Set(); for (let i = 1; i <= backlog; i += 1) failing.add(i);
  const fixedAwaitingMerge = new Set();
  let launchedBuilds = 0, mergedFixes = 0, fixRuns = 0;
  let active = 0, maxActive = 0, fixActive = 0, maxFix = 0;
  let sawActiveBranchesSet = false;
  let draftSeen = false;
  const planSome = async ({ k }) => {
    await sleep(1);
    if (launchedBuilds >= budget) return { slices: [], empty: true };
    const give = Math.min(k, budget - launchedBuilds);
    const slices = Array.from({ length: give }, () => {
      launchedBuilds += 1;
      return { id: `b-${launchedBuilds}`, repo: 'o/a', title: 't', paths: [`p${launchedBuilds}.ts`], kind: 'feature' };
    });
    return { slices, empty: false };
  };
  const runWorker = async ({ slice }) => { active += 1; maxActive = Math.max(maxActive, active); await sleep(4); active -= 1; return { slice, ok: true }; };
  // Half the backlog is stale DRAFTs (unfinished reviews) — the scan routes them
  // through the fix lane exactly like DIRTY/UNSTABLE PRs, per the merge lane's
  // readyDrafts:false policy.
  const findFixablePrs = (repos, activeBranches) => {
    if (activeBranches instanceof Set) sawActiveBranchesSet = true;
    return [...failing].map((n) => ({
      repo: 'o/a', number: n, branch: `worker-1/x${n}`, state: n % 2 === 0 ? 'DRAFT' : 'UNSTABLE',
    }));
  };
  const runFixWorker = async (item) => {
    fixRuns += 1; active += 1; fixActive += 1; maxActive = Math.max(maxActive, active); maxFix = Math.max(maxFix, fixActive);
    if (item.state === 'DRAFT') draftSeen = true;
    await sleep(5);
    failing.delete(item.number); fixedAwaitingMerge.add(item.number); // fix succeeded
    fixActive -= 1; active -= 1; return { ...item, ok: true };
  };
  const mergeWorkerPrs = () => {
    const out = [];
    for (const n of [...fixedAwaitingMerge]) { fixedAwaitingMerge.delete(n); mergedFixes += 1; out.push('o/a#' + n); }
    return out;
  };
  await runPool({
    args: makeArgs({ workers: K, fixWorkers: fixCap }), runDir: '/tmp/pf-run7', roles, sliceBudget: budget,
    deps: { planSome, runWorker, findFixablePrs, runFixWorker, mergeWorkerPrs, runReconcile: async () => {} },
  });
  assert.equal(launchedBuilds, budget, 'all builds launched');
  assert.ok(failing.size === 0 && fixRuns >= backlog, `drained the whole failing backlog (${fixRuns} fix runs / ${backlog})`);
  assert.equal(mergedFixes, backlog, 'every fixed PR was merged');
  assert.ok(maxActive <= K, 'never exceeded K total workers');
  assert.ok(maxFix <= fixCap, 'respected the fix cap');
  assert.ok(maxFix === fixCap && maxActive > fixCap, 'ran fixes concurrently with builds (cap reached)');
  assert.ok(sawActiveBranchesSet, 'fix scans receive the active-branch set (legit in-build drafts stay out of the lane)');
  assert.ok(draftSeen, 'stale DRAFT PRs are routed through the fix lane');
});

// ---- seed slices: validated, launched first, excluded from planning ----
test('seed slices pre-load the queue and the planner tops up around them', POOL, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'planforge-seed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seedPath = join(dir, 'seeds.json');
  const seeds = [
    { id: 'seed-one', repo: 'o/a', title: 'seed 1', kind: 'feature', paths: ['seed/one.ts'] },
    { id: 'seed-two', repo: 'o/b', title: 'seed 2', kind: 'feature', paths: ['seed/two.ts'] },
  ];
  writeFileSync(seedPath, JSON.stringify(seeds));

  const events = [];
  const launchedOrder = [];
  let firstPlanExclusion = null;
  let planned = 0;
  const planSome = async ({ k, inFlight }) => {
    await sleep(1);
    if (firstPlanExclusion === null) firstPlanExclusion = inFlight.map((s) => s.id);
    if (planned >= 3) return { slices: [], empty: true };
    const slices = Array.from({ length: Math.min(k, 3 - planned) }, () => {
      planned += 1;
      return { id: `pl-${planned}`, repo: 'o/c', title: 't', paths: [`pp${planned}.ts`], kind: 'feature' };
    });
    return { slices, empty: false };
  };
  const runWorker = async ({ slice }) => { launchedOrder.push(slice.id); await sleep(3); return { slice, ok: true }; };
  // 3 workers > 2 seeds, so the first planner top-up fires while BOTH seeds are
  // still in flight — proving the exclusion set covers seeded work.
  await runPool({
    args: makeArgs({ workers: 3, seedSlices: seedPath }), runDir: '/tmp/pf-run8', roles, sliceBudget: 10,
    emit: (type, data) => events.push({ type, ...data }),
    deps: { planSome, runWorker, mergeWorkerPrs: () => [], runReconcile: async () => {} },
  });

  assert.deepEqual(launchedOrder.slice(0, 2), ['seed-one', 'seed-two'], 'seeds launch before planner output');
  assert.equal(launchedOrder.length, 5, 'seeds + planner slices all built');
  const seedEvent = events.find((e) => e.type === 'seed-slices');
  assert.ok(seedEvent, 'seed-slices event emitted');
  assert.equal(seedEvent.count, 2);
  assert.deepEqual(seedEvent.ids, ['seed-one', 'seed-two']);
  assert.ok(
    firstPlanExclusion.includes('seed-one') && firstPlanExclusion.includes('seed-two'),
    `the first planner call excludes the seeds (got ${JSON.stringify(firstPlanExclusion)})`
  );
});

test('invalid seed slices abort the run with a clear error', POOL, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'planforge-seed-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seedPath = join(dir, 'seeds.json');
  // Two seeds overlap in the same repo -> must be rejected up front.
  writeFileSync(seedPath, JSON.stringify([
    { id: 's1', repo: 'o/a', title: 't', paths: ['src/*.ts'] },
    { id: 's2', repo: 'o/a', title: 't', paths: ['src/x.ts'] },
  ]));
  await assert.rejects(
    runPool({
      args: makeArgs({ seedSlices: seedPath }), runDir: '/tmp/pf-run9', roles, sliceBudget: 4,
      deps: { planSome: async () => ({ slices: [], empty: true }), runWorker: async () => ({ ok: true }), mergeWorkerPrs: () => [], runReconcile: async () => {} },
    }),
    /--seed-slices: invalid seed file.*overlap/s
  );
  // Repo out of scope is also rejected.
  writeFileSync(seedPath, JSON.stringify([{ id: 's3', repo: 'other/repo', title: 't', paths: ['a.ts'] }]));
  await assert.rejects(
    runPool({
      args: makeArgs({ seedSlices: seedPath }), runDir: '/tmp/pf-run9b', roles, sliceBudget: 4,
      deps: { planSome: async () => ({ slices: [], empty: true }), runWorker: async () => ({ ok: true }), mergeWorkerPrs: () => [], runReconcile: async () => {} },
    }),
    /not in scope/
  );
});

// ---- events: shapes match the ARCHITECTURE.md §2 contract ----
test('event stream carries the contract shapes', POOL, async () => {
  const events = [];
  let n = 0;
  const planSome = async ({ k }) => {
    await sleep(1);
    if (n >= 4) return { slices: [], empty: true };
    const slices = Array.from({ length: Math.min(k, 4 - n) }, () => {
      n += 1;
      return { id: `e-${n}`, repo: 'o/a', title: `title ${n}`, paths: [`e${n}.ts`], kind: 'feature' };
    });
    return { slices, empty: false };
  };
  const runWorker = async ({ slotId, slice }) => {
    await sleep(2);
    return { slice, ok: true, branch: `worker-${slotId}/${slice.id}` };
  };
  await runPool({
    args: makeArgs({ workers: 2 }), runDir: '/tmp/pf-run10', roles, sliceBudget: 4,
    emit: (type, data) => events.push({ type, ...data }),
    deps: { planSome, runWorker, mergeWorkerPrs: () => ['o/a#1'], runReconcile: async () => {} },
  });

  const ofType = (type) => events.filter((e) => e.type === type);

  const runStart = events[0];
  assert.equal(runStart.type, 'run-start', 'run-start is the first event');
  assert.equal(runStart.workers, 2);
  assert.equal(runStart.budget, 4);
  assert.deepEqual(runStart.repos, ['o/a', 'o/b', 'o/c']);

  for (const e of ofType('plan-start')) {
    assert.equal(typeof e.tag, 'string');
    assert.equal(typeof e.want, 'number');
  }
  for (const e of ofType('plan-result')) {
    assert.ok(['queued', 'empty', 'saturated', 'provider-switch'].includes(e.status), `plan-result status ${e.status}`);
    assert.equal(typeof e.queued, 'number');
    assert.ok(Array.isArray(e.ids));
  }

  const launches = ofType('launch');
  assert.equal(launches.length, 4);
  for (const e of launches) {
    assert.equal(typeof e.slot, 'number');
    assert.equal(typeof e.sliceId, 'string');
    assert.equal(e.repo, 'o/a');
    assert.equal(typeof e.title, 'string');
    assert.equal(e.kind, 'feature');
    assert.equal(typeof e.index, 'number');
    assert.equal(e.budget, 4);
  }

  const dones = ofType('worker-done');
  assert.equal(dones.length, 4, 'one worker-done per launch');
  for (const e of dones) {
    assert.equal(typeof e.slot, 'number');
    assert.equal(typeof e.sliceId, 'string');
    assert.equal(e.ok, true);
    assert.match(e.branch, /^worker-\d+\//);
  }

  const merges = ofType('merge');
  assert.ok(merges.length >= 4, 'a merge event per merge pass that landed PRs');
  for (const e of merges) {
    assert.equal(typeof e.label, 'string');
    assert.ok(Array.isArray(e.merged) && e.merged.every((m) => /^[\w.-]+\/[\w.-]+#\d+$/.test(m)));
  }

  const stats = ofType('stats');
  assert.ok(stats.length > 0);
  for (const e of stats) {
    for (const key of ['launched', 'budget', 'inFlight', 'queued', 'mergedPrs', 'mergedSlices', 'failed', 'fixing', 'fixQueued', 'fixed', 'elapsedMs']) {
      assert.equal(typeof e[key], 'number', `stats.${key}`);
    }
    assert.equal(typeof e.dry, 'boolean');
  }

  const done = events[events.length - 1];
  assert.equal(done.type, 'run-done', 'run-done is the last event');
  assert.equal(done.launched, 4);
  assert.equal(typeof done.mergedPrs, 'number');
  assert.equal(done.failed, 0);
  assert.equal(typeof done.fixed, 'number');
});

// ---- emitter: NDJSON file + "@event " stdout mirror ----
test('createEmitter appends NDJSON and mirrors @event lines on stdout', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'planforge-emit-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const emit = createEmitter(runDir);
  let captured = '';
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => { captured += chunk; return true; };
  try {
    emit('launch', { slot: 1, sliceId: 'x' });
    emit('merge', { label: 'after x', merged: ['o/a#1'] });
  } finally {
    process.stdout.write = orig;
  }
  const lines = readFileSync(join(runDir, 'events.ndjson'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.type, 'launch');
  assert.equal(first.slot, 1);
  assert.equal(typeof first.t, 'number');
  const second = JSON.parse(lines[1]);
  assert.deepEqual(second.merged, ['o/a#1']);
  const stdoutLines = captured.trim().split('\n');
  assert.equal(stdoutLines.length, 2);
  for (const [i, line] of stdoutLines.entries()) {
    assert.ok(line.startsWith('@event '), 'stdout line is prefixed @event ');
    assert.equal(line.slice('@event '.length), lines[i], 'stdout mirrors the exact NDJSON line');
  }
});

// ---- disjointness validation (planner output gate) ----
test('validateSlices: disjointness, scope, and shape rules', () => {
  const repos = ['o/a', 'o/b'];
  const good = [
    { id: 'one', repo: 'o/a', title: 't', paths: ['src/one.ts'] },
    { id: 'two', repo: 'o/a', title: 't', paths: ['src/two.ts'] },
    { id: 'three', repo: 'o/b', title: 't', paths: ['src/one.ts'] }, // same path, other repo: fine
  ];
  const ok = validateSlices(good, 3, repos);
  assert.ok(ok.ok);
  assert.equal(ok.slices.length, 3);
  assert.ok(ok.slices.every((s) => s.kind === 'feature'), 'kind defaults to feature');

  const overlap = validateSlices(
    [
      { id: 'w', repo: 'o/a', title: 't', paths: ['src/*.ts'] },
      { id: 'x', repo: 'o/a', title: 't', paths: ['src/x.ts'] },
    ],
    2, repos
  );
  assert.ok(!overlap.ok && overlap.problems.some((p) => /overlap/.test(p)), 'same-repo glob overlap rejected');

  const inFlight = [{ id: 'busy', repo: 'o/a', paths: ['lib/**'] }];
  const clash = validateSlices([{ id: 'y', repo: 'o/a', title: 't', paths: ['lib/util.ts'] }], 1, repos, inFlight);
  assert.ok(!clash.ok && clash.problems.some((p) => /in-flight/.test(p)), 'in-flight overlap rejected');

  const dupInFlight = validateSlices([{ id: 'busy', repo: 'o/b', title: 't', paths: ['q.ts'] }], 1, repos, inFlight);
  assert.ok(!dupInFlight.ok && dupInFlight.problems.some((p) => /duplicates an in-flight/.test(p)));

  const dup = validateSlices(
    [
      { id: 'same', repo: 'o/a', title: 't', paths: ['a.ts'] },
      { id: 'same', repo: 'o/b', title: 't', paths: ['b.ts'] },
    ],
    2, repos
  );
  assert.ok(!dup.ok && dup.problems.includes('duplicate slice ids'));

  const outOfScope = validateSlices([{ id: 'z', repo: 'evil/repo', title: 't', paths: ['a.ts'] }], 1, repos);
  assert.ok(!outOfScope.ok && outOfScope.problems.some((p) => /not in scope/.test(p)));

  const empty = validateSlices([], 3, repos);
  assert.ok(empty.empty && !empty.ok, 'empty array reports empty, not failure');

  const notArray = validateSlices({ nope: true }, 3, repos);
  assert.ok(!notArray.ok && !notArray.empty);

  const noPaths = validateSlices([{ id: 'p', repo: 'o/a', title: 't', paths: [] }], 1, repos);
  assert.ok(!noPaths.ok && noPaths.problems.some((p) => /non-empty "paths"/.test(p)));

  const refactorKept = validateSlices([{ id: 'r', repo: 'o/a', title: 't', paths: ['big.ts'], kind: 'refactor' }], 1, repos);
  assert.equal(refactorKept.slices[0].kind, 'refactor');
});

test('pathsOverlap + globToRegex', () => {
  assert.ok(pathsOverlap(['src/*.ts'], ['src/a.ts']), 'wildcard covers file');
  assert.ok(pathsOverlap(['src/a.ts'], ['src/a.ts']), 'identical literal');
  assert.equal(pathsOverlap(['src/a.ts'], ['src/b.ts']), null, 'siblings do not overlap');
  assert.ok(pathsOverlap(['src/**'], ['src/deep/nested/file.ts']), '** is recursive');
  assert.equal(pathsOverlap(['src/*.ts'], ['lib/a.ts']), null);
  assert.ok(globToRegex('a/*/c.ts').test('a/b/c.ts'));
  assert.ok(!globToRegex('a/*/c.ts').test('a/b/d/c.ts'), 'single * is one segment');
  assert.ok(globToRegex('a/**').test('a/b/d/c.ts'));
});

test('extractJsonArray finds the last fenced block or a bare array', () => {
  assert.deepEqual(extractJsonArray('text\n```json\n[{"id":"a"}]\n```\nafter'), [{ id: 'a' }]);
  assert.deepEqual(extractJsonArray('no fence [1, 2, 3] trailing'), [1, 2, 3]);
  assert.deepEqual(
    extractJsonArray('```json\n[{"id":"old"}]\n```\nmid\n```json\n[{"id":"new"}]\n```'),
    [{ id: 'new' }],
    'last fence wins'
  );
  assert.equal(extractJsonArray('nothing here'), null);
  assert.equal(extractJsonArray('```json\n{"not":"array"}\n```'), null);

  // Codex-style transcript: the real slice array comes early, then tool output
  // (`gh pr list` → []) and trailing prose. Must still pick the slice array,
  // not the empty [] and not the prompt's placeholder example.
  const codex = [
    'Example format: ```json\n[{"id":"kebab-case-stable-id","repo":"owner/repo","paths":["x"]}]\n```',
    'OUTPUT:',
    '```json\n[{"id":"album-crud","repo":"acme/app","paths":["a.ts"]}]\n```',
    'exec gh pr list ... succeeded:',
    '[]',
    'The repo has no open PRs; continuing through the phases.',
  ].join('\n');
  const got = extractJsonArray(codex);
  assert.equal(got?.length, 1);
  assert.equal(got[0].id, 'album-crud');

  // A genuinely empty result (no slice array anywhere) still returns [].
  assert.deepEqual(extractJsonArray('surveyed everything; nothing actionable:\n```json\n[]\n```'), []);
});

// ---- planner prompt content ----
test('planner prompt surveys the plans dir, gates on decisions, and injects preferences', () => {
  const prompt = buildPlannerPrompt({
    k: 3,
    repos: ['o/a', 'o/b'],
    feedback: '',
    refactorRound: false,
    inFlight: [{ id: 'busy-1', repo: 'o/a', paths: ['src/busy.ts'] }],
    plansPath: '/ws/plans',
    preferencesSummary: 'Web apps: react + vite; testing: vitest.',
  });
  assert.ok(prompt.includes('/ws/plans'), 'names the plans dir');
  assert.ok(prompt.includes('*-build-plan.md'), 'surveys the plan documents');
  assert.ok(/## 3\. Open decisions/.test(prompt) && /blocked-on-Dx/.test(prompt) && /NOT Accepted/i.test(prompt), 'decision gating spelled out');
  assert.ok(/## 4\. Phases/.test(prompt) && /phase order/i.test(prompt), 'phase ordering spelled out');
  assert.ok(prompt.includes('Web apps: react + vite; testing: vitest.'), 'preferences summary injected');
  assert.ok(prompt.includes('busy-1') && prompt.includes('src/busy.ts'), 'in-flight exclusion listed');
  assert.ok(prompt.includes('"id": "kebab-case-stable-id"'), 'JSON output shape shown');
  const refactorPrompt = buildPlannerPrompt({
    k: 2, repos: ['o/a'], feedback: '', refactorRound: true, inFlight: [], plansPath: '/ws/plans',
  });
  assert.ok(/EXACTLY ONE.*refactor/i.test(refactorPrompt));
});

// ---- provider auto-failover (env slots) ----
test('auto provider: selection, reactive demotion, dual-role fallback', (t) => {
  const SNAP = ['CODEX_CHAIN_CMD', 'CLAUDE_CHAIN_CMD', 'CLAUDE_CHAIN_STDIN', 'CHAIN_BUILDER_LABEL', 'CHAIN_REVIEWER_LABEL', 'PLANFORGE_PROVIDERS_OUT'];
  const saved = Object.fromEntries(SNAP.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const k of SNAP) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  for (const k of SNAP) delete process.env[k];

  const auto = createAutoProvider({
    providers: {
      builderPriority: ['codex', 'claude'],
      reviewerPriority: ['claude', 'codex'],
      dualRoleAllowed: ['claude'],
    },
  });

  const r0 = auto.sync();
  assert.equal(r0.builder, 'codex');
  assert.equal(r0.reviewer, 'claude');
  assert.ok(process.env.CODEX_CHAIN_CMD.includes('agent-codex.mjs'), 'builder slot -> agent-codex.mjs');
  assert.ok(process.env.CODEX_CHAIN_CMD.includes('{workspace}'), 'builder slot keeps the {workspace} template');
  assert.ok(process.env.CLAUDE_CHAIN_CMD.includes('agent-claude.mjs'), 'reviewer slot -> agent-claude.mjs');
  assert.equal(process.env.CLAUDE_CHAIN_STDIN, '1', 'reviewer slot reads stdin');
  assert.equal(process.env.CHAIN_BUILDER_LABEL, 'Codex');
  assert.equal(process.env.CHAIN_REVIEWER_LABEL, 'Claude');

  // codex hits insufficient_quota -> demote codex -> claude fills BOTH roles.
  const s1 = auto.noteWorkerLog('Error: 429 insufficient_quota — you exceeded your current quota');
  assert.ok(s1 && s1.demoted.includes('codex'), 'reported demoting codex');
  assert.equal(s1.roles.builder, 'claude');
  assert.equal(s1.roles.reviewer, 'claude');
  assert.ok(process.env.CODEX_CHAIN_CMD.includes('agent-claude.mjs'), 'builder slot re-pointed at agent-claude.mjs');

  // A clean worker log triggers no switch.
  assert.equal(auto.noteWorkerLog('Done. PR ready, checks green.'), null);
});

test('auto provider: missing agent scripts and PLANFORGE_PROVIDERS_OUT are excluded', (t) => {
  const saved = process.env.PLANFORGE_PROVIDERS_OUT;
  const savedSlots = { b: process.env.CODEX_CHAIN_CMD, r: process.env.CLAUDE_CHAIN_CMD };
  t.after(() => {
    if (saved === undefined) delete process.env.PLANFORGE_PROVIDERS_OUT;
    else process.env.PLANFORGE_PROVIDERS_OUT = saved;
    if (savedSlots.b === undefined) delete process.env.CODEX_CHAIN_CMD; else process.env.CODEX_CHAIN_CMD = savedSlots.b;
    if (savedSlots.r === undefined) delete process.env.CLAUDE_CHAIN_CMD; else process.env.CLAUDE_CHAIN_CMD = savedSlots.r;
  });
  delete process.env.PLANFORGE_PROVIDERS_OUT;

  // "ghost" has no agent script -> skipped; codex leads.
  const auto = createAutoProvider({
    providers: { builderPriority: ['ghost', 'codex', 'claude'], reviewerPriority: ['claude', 'codex'], dualRoleAllowed: ['claude'] },
  });
  assert.deepEqual(auto.available().sort(), ['claude', 'codex']);
  assert.equal(auto.sync().builder, 'codex');

  // Pre-marking codex out starts the run on claude/claude.
  process.env.PLANFORGE_PROVIDERS_OUT = 'codex';
  const auto2 = createAutoProvider({
    providers: { builderPriority: ['codex', 'claude'], reviewerPriority: ['claude', 'codex'], dualRoleAllowed: ['claude'] },
  });
  const r = auto2.sync();
  assert.equal(r.builder, 'claude');
  assert.equal(r.reviewer, 'claude');
});

// ---- runOrchestrator: config-driven dry run writes nothing, sets model env ----
test('runOrchestrator --dry-run: config-driven, no writes, model env applied', POOL, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'planforge-dry-'));
  const SNAP = ['CODEX_CHAIN_CMD', 'CLAUDE_CHAIN_CMD', 'CLAUDE_CHAIN_STDIN', 'CLAUDE_CHAIN_MODEL', 'CLAUDE_CHAIN_FALLBACK_MODEL', 'CLAUDE_CHAIN_EFFORT', 'CODEX_CHAIN_MODEL', 'CHAIN_BUILDER_LABEL', 'CHAIN_REVIEWER_LABEL'];
  const saved = Object.fromEntries(SNAP.map((k) => [k, process.env[k]]));
  t.after(() => {
    rmSync(ws, { recursive: true, force: true });
    for (const k of SNAP) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  for (const k of SNAP) delete process.env[k];
  writeFileSync(join(ws, 'planforge.config.json'), JSON.stringify({
    repos: ['acme/app'],
    models: { claude: 'claude-test-model', claudeFallback: 'claude-test-fallback', claudeEffort: 'medium', codex: 'gpt-test' },
  }));
  const config = loadConfig(ws);
  await runOrchestrator(config, { dryRun: true });
  assert.equal(process.env.CLAUDE_CHAIN_MODEL, 'claude-test-model');
  assert.equal(process.env.CLAUDE_CHAIN_FALLBACK_MODEL, 'claude-test-fallback');
  assert.equal(process.env.CLAUDE_CHAIN_EFFORT, 'medium');
  assert.equal(process.env.CODEX_CHAIN_MODEL, 'gpt-test');
  assert.ok(process.env.CODEX_CHAIN_CMD.includes('agent-codex.mjs'), 'auto selection ran by default');
  assert.ok(!existsSync(join(ws, '.planforge')), 'dry run creates no scratch dirs');
});

test('runOrchestrator refuses an empty repo list', POOL, async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'planforge-norepos-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  writeFileSync(join(ws, 'planforge.config.json'), JSON.stringify({}));
  const config = loadConfig(ws);
  await assert.rejects(runOrchestrator(config, { dryRun: true }), /No repos in scope/);
});

// ---- plain-English user requests -> planner-scoped slices ----
test('buildPlannerPrompt includes user requests with the fromRequest directive', () => {
  const prompt = buildPlannerPrompt({
    k: 2, repos: ['o/a'], plansPath: '/ws/plans',
    userRequests: [
      { id: 'req-1', repo: 'o/a', text: 'fix the typo on the login page' },
      { id: 'req-2', repo: null, text: 'the date picker is broken on mobile' },
    ],
  });
  assert.ok(prompt.includes('USER-REQUESTED TASKS'));
  assert.ok(prompt.includes('[req-1] (repo o/a) fix the typo on the login page'));
  assert.ok(prompt.includes('[req-2] the date picker is broken on mobile'));
  assert.ok(prompt.includes('"fromRequest"'), 'tells the planner how to tag derived slices');

  const bare = buildPlannerPrompt({ k: 2, repos: ['o/a'], plansPath: '/ws/plans' });
  assert.ok(!bare.includes('USER-REQUESTED TASKS'), 'no request block when there are none');
});

test('pool: a fromRequest slice clears its pending request for later plans', POOL, async () => {
  const seenRequests = [];
  let call = 0;
  const planSome = async ({ userRequests }) => {
    call += 1;
    seenRequests.push(userRequests.map((r) => r.id));
    if (call === 1) {
      return { slices: [{ id: 'fix-login-typo', repo: 'o/a', title: 'Fix login typo', kind: 'feature', paths: ['web/login.html'], fromRequest: 'req-1' }], empty: false };
    }
    return { slices: [], empty: true };
  };
  const runWorker = async (a) => ({ ...a, ok: true, branch: 'worker-1/x' });
  await runPool({
    args: makeArgs({ workers: 1, requests: [{ text: 'fix the typo on the login page' }] }),
    runDir: '/tmp/run-req', roles, sliceBudget: 5,
    deps: { planSome, runWorker, mergeWorkerPrs: () => [], runReconcile: async () => {} },
  });
  assert.deepEqual(seenRequests[0], ['req-1'], 'first plan sees the pending request');
  for (const later of seenRequests.slice(1)) {
    assert.deepEqual(later, [], 'request no longer pending after its slice was planned');
  }
});

// ---- verify-and-repair: build/test the project, spend budget fixing it ----
import { runVerify } from './orchestrator.mjs';

test('runVerify stops at the first failing step and returns its log tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-verify-'));
  // `true` passes, `false` fails — portable shell builtins.
  const ok = runVerify(dir, [{ id: 'build', command: 'true' }]);
  assert.equal(ok.ok, true);
  const bad = runVerify(dir, [{ id: 'build', command: 'true' }, { id: 'test', command: 'false' }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.failedStep, 'test');
});

test('the pool verifies a project and repairs a failing build with budget', POOL, async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-verify-ws-'));
  mkdirSync(join(ws, 'app'), { recursive: true });
  writeFileSync(join(ws, 'app', 'package.json'), JSON.stringify({ scripts: { build: 'vite build', test: 'vitest' } }));

  const events = [];
  const emit = (type, payload) => events.push({ type, ...payload });
  let verifyCalls = 0;
  const runVerifyStub = () => (++verifyCalls === 1 ? { ok: false, failedStep: 'build', command: 'vite build', logTail: 'TypeError: boom' } : { ok: true });
  const builtFixes = [];
  const runWorker = async (a) => { builtFixes.push(a.slice); return { ...a, ok: true, branch: 'worker-1/x' }; };

  await runPool({
    args: makeArgs({ workers: 1, repos: ['o/app'], workspace: ws }),
    runDir: join(ws, '.planforge', 'runs', 'r'),
    roles, sliceBudget: 10, emit,
    deps: { planSome: async () => ({ slices: [], empty: true }), runWorker, mergeWorkerPrs: () => [], runReconcile: async () => {}, runVerify: runVerifyStub },
  });

  assert.equal(verifyCalls >= 2, true, 'verified, repaired, then re-verified');
  assert.equal(builtFixes.length, 1, 'one repair slice built');
  assert.equal(builtFixes[0].kind, 'fix');
  assert.match(builtFixes[0].notes, /build step failed|TypeError: boom/);
  assert.ok(events.some((e) => e.type === 'verify-start' && e.repo === 'o/app'));
  assert.ok(events.some((e) => e.type === 'verify-repair'));
  assert.ok(events.some((e) => e.type === 'verify-result' && e.ok === true));
});

test('verify-only: skips planning/building, still verifies and repairs', POOL, async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-vonly-'));
  mkdirSync(join(ws, 'app'), { recursive: true });
  writeFileSync(join(ws, 'app', 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));

  let planned = 0;
  const planSome = async () => { planned += 1; return { slices: [], empty: true }; };
  let verifyCalls = 0;
  const runVerifyStub = () => (++verifyCalls === 1 ? { ok: false, failedStep: 'build', command: 'tsc', logTail: 'TS2688' } : { ok: true });
  const fixes = [];
  const runWorker = async (a) => { fixes.push(a.slice); return { ...a, ok: true, branch: 'worker-1/x' }; };

  await runPool({
    args: makeArgs({ workers: 1, repos: ['o/app'], workspace: ws, verifyOnly: true }),
    runDir: join(ws, '.planforge', 'runs', 'r'),
    roles, sliceBudget: 10, emit: () => {},
    deps: { planSome, runWorker, mergeWorkerPrs: () => [], runReconcile: async () => {}, runVerify: runVerifyStub },
  });

  assert.equal(planned, 0, 'verify-only never calls the planner');
  assert.equal(fixes.length, 1, 'it still repaired the failing build');
  assert.equal(fixes[0].kind, 'fix');
});
