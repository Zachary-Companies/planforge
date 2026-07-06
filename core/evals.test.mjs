import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAcceptanceCriteria,
  criteriaFromSlice,
  buildEvalPrompt,
  parseVerdict,
  readVerdict,
  normalizeResult,
  verdictPath,
  runAcceptanceEvals,
  summarizeEvalReport,
} from './evals.mjs';

const PLAN = `# Demo — build plan

## 4. Phases

### Phase 1 — Skeleton

- **auth-email — Email sign in**
  - paths: \`web/src/auth.ts\`
  - status: shipped
  - acceptance: signing up with a new email returns a session and lands on the home page
  - acceptance: a wrong password shows "Email or password is incorrect."
- **upload-photo — Upload a photo**
  - paths: \`web/src/upload.ts\`
  - deps: auth-email
  - status: shipped
  - acceptance: an album member can upload an image and see it appear in the album

### Phase 2 — Later

- **no-criteria-slice — A slice with no acceptance**
  - paths: \`x.ts\`
  - status: pending

## 5. Status ledger
- verified against abc123 2026-07-06 — initial
`;

test('parseAcceptanceCriteria extracts per-slice criteria, ignoring slices without any', () => {
  const slices = parseAcceptanceCriteria(PLAN);
  assert.equal(slices.length, 2, 'only the two slices that declare acceptance');
  const auth = slices.find((s) => s.id === 'auth-email');
  assert.equal(auth.title, 'Email sign in');
  assert.equal(auth.status, 'shipped');
  assert.equal(auth.criteria.length, 2);
  assert.match(auth.criteria[0], /returns a session/);
  assert.match(auth.criteria[1], /incorrect/);
  const upload = slices.find((s) => s.id === 'upload-photo');
  assert.equal(upload.criteria.length, 1);
  assert.ok(!slices.some((s) => s.id === 'no-criteria-slice'), 'a slice with no acceptance is skipped');
});

test('parseAcceptanceCriteria handles em dash, en dash, and hyphen separators', () => {
  const md = [
    '- **a-slice — em dash**\n  - acceptance: x',
    '- **b-slice – en dash**\n  - acceptance: y',
    '- **c-slice - hyphen**\n  - acceptance: z',
  ].join('\n');
  const ids = parseAcceptanceCriteria(md).map((s) => s.id).sort();
  assert.deepEqual(ids, ['a-slice', 'b-slice', 'c-slice']);
});

test('criteriaFromSlice synthesizes acceptance for slices the plan does not cover', () => {
  // a planner-derived user request: not in the plan document, but MUST still be evaluated
  const s = criteriaFromSlice({
    id: 'gallery-navigation-fix',
    title: 'Fix gallery next/back image disappearance',
    rationale: 'user reported images turn white when navigating',
    notes: 'clicking next/prev makes portraits render white',
  });
  assert.equal(s.id, 'gallery-navigation-fix');
  assert.equal(s.synthesized, true);
  assert.equal(s.criteria.length, 1);
  assert.match(s.criteria[0], /works end-to-end/);
  assert.match(s.criteria[0], /no longer reproduces/);
  assert.match(s.criteria[0], /images turn white/);

  // a slice with no description at all cannot be evaluated
  assert.equal(criteriaFromSlice({ id: 'bare' }), null);
});

test('buildEvalPrompt embeds criteria, the verdict path, and the independence framing', () => {
  const slice = { id: 'auth-email', title: 'Email sign in', criteria: ['crit one', 'crit two'] };
  const p = buildEvalPrompt({ slice, verdictFile: '/tmp/x/auth-email.verdict.json' });
  assert.match(p, /INDEPENDENT ACCEPTANCE EVALUATOR/);
  assert.match(p, /1\. crit one/);
  assert.match(p, /2\. crit two/);
  assert.match(p, /\/tmp\/x\/auth-email\.verdict\.json/);
  assert.match(p, /do not trust that it works/i);
  assert.match(p, /only add or adjust TESTS/i); // must not edit feature code to force a pass
});

test('parseVerdict pulls the last @eval-verdict json line from stdout', () => {
  const out = 'noise\n@eval-verdict {"sliceId":"a","status":"fail"}\nmore\n@eval-verdict {"sliceId":"a","status":"pass","criteria":[]}\n';
  assert.equal(parseVerdict(out).status, 'pass');
  assert.equal(parseVerdict('nothing here'), null);
});

test('normalizeResult: pass only when the verdict says pass AND every declared criterion is met', () => {
  const slice = { id: 's', title: 'S', criteria: ['a', 'b'] };
  const pass = normalizeResult(slice, {
    status: 'pass',
    criteria: [{ text: 'a', met: true, evidence: 'ran test A' }, { text: 'b', met: true, evidence: 'ran test B' }],
    testsAdded: ['t.test.ts'],
  });
  assert.equal(pass.status, 'pass');
  assert.equal(pass.met, 2);
  assert.deepEqual(pass.testsAdded, ['t.test.ts']);

  // claims pass but a criterion is not met → fail
  const lying = normalizeResult(slice, { status: 'pass', criteria: [{ text: 'a', met: true }, { text: 'b', met: false }] });
  assert.equal(lying.status, 'fail');

  // covers fewer criteria than declared → fail (can't pass what wasn't checked)
  const short = normalizeResult(slice, { status: 'pass', criteria: [{ text: 'a', met: true }] });
  assert.equal(short.status, 'fail');

  // no/garbled verdict → error, never pass
  assert.equal(normalizeResult(slice, null).status, 'error');
  assert.equal(normalizeResult(slice, 'not an object').status, 'error');
});

test('runAcceptanceEvals reads the verdict file the evaluator writes and aggregates a report', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'pf-evals-'));
  const slices = [
    { id: 'good', title: 'Good', criteria: ['works'] },
    { id: 'bad', title: 'Bad', criteria: ['works', 'also works'] },
    { id: 'silent', title: 'Silent', criteria: ['works'] },
  ];
  const events = [];
  // fake evaluator: writes a verdict file for good/bad, writes nothing for silent
  const runEvaluator = async (slice, { verdictFile }) => {
    if (slice.id === 'good') {
      writeFileSync(verdictFile, JSON.stringify({ sliceId: 'good', status: 'pass', criteria: [{ text: 'works', met: true, evidence: 'ran it' }], testsAdded: ['good.test.ts'] }));
    } else if (slice.id === 'bad') {
      writeFileSync(verdictFile, JSON.stringify({ sliceId: 'bad', status: 'fail', criteria: [{ text: 'works', met: true }, { text: 'also works', met: false, evidence: '500 error' }], notes: 'second path 500s' }));
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const report = await runAcceptanceEvals({ slices, repoDir: '/repo', logDir, runEvaluator, emit: (t, d) => events.push([t, d]) });

  assert.equal(report.total, 3);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 2);
  assert.equal(report.results.find((r) => r.sliceId === 'good').status, 'pass');
  assert.equal(report.results.find((r) => r.sliceId === 'bad').status, 'fail');
  assert.equal(report.results.find((r) => r.sliceId === 'silent').status, 'error', 'no verdict written = error, not silent pass');
  // events emitted for each slice
  assert.equal(events.filter(([t]) => t === 'eval-start').length, 3);
  assert.equal(events.filter(([t]) => t === 'eval-result').length, 3);
  // a stale verdict from a previous run must not count — it is cleared first
  assert.ok(existsSync(verdictPath(logDir, 'good')));
});

test('runAcceptanceEvals falls back to a stdout verdict when no file is written', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'pf-evals2-'));
  const slices = [{ id: 'via-stdout', title: 'X', criteria: ['works'] }];
  const runEvaluator = async () => ({ code: 0, stdout: '@eval-verdict {"sliceId":"via-stdout","status":"pass","criteria":[{"text":"works","met":true,"evidence":"e"}]}\n', stderr: '' });
  const report = await runAcceptanceEvals({ slices, repoDir: '/repo', logDir, runEvaluator });
  assert.equal(report.passed, 1);
});

test('summarizeEvalReport renders a per-slice line with counts', () => {
  const report = {
    total: 2, passed: 1, failed: 1,
    results: [
      { sliceId: 'good', status: 'pass', met: 1, total: 1, notes: '' },
      { sliceId: 'bad', status: 'fail', met: 1, total: 2, notes: 'second path 500s' },
    ],
  };
  const s = summarizeEvalReport(report);
  assert.match(s, /1\/2 slices acceptance-verified, 1 failed/);
  assert.match(s, /✔ good/);
  assert.match(s, /✖ bad\s+\(1\/2 criteria\) — second path 500s/);
});
