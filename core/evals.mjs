// Acceptance evals — prove each slice's asked-for feature actually works,
// instead of trusting that "it merged" or "the build is green" means done.
//
// The gap this closes: a plan slice carries `acceptance:` criteria (objective,
// checkable outcomes), but nothing ever RAN them. Build/test only proves the
// project compiles and its own tests pass — tests the same builder wrote. So a
// feature could be marked "shipped" while being broken end-to-end (auth that
// 500s, uploads that 403, a 3D gallery unreachable or blank).
//
// An eval here is an INDEPENDENT check: a fresh evaluator agent (ideally a
// different provider than the builder) is given a slice's acceptance criteria
// and the repo, and must prove each criterion by actually exercising it —
// running the build/tests, and adding a focused repeatable test for anything
// not already covered — then write a structured verdict. A slice passes only
// when every criterion is met with evidence. The verdict is a file (robust
// across provider output formats), and any test the evaluator adds persists in
// the suite so the guarantee holds in CI, not just once.
//
// Pure helpers (parse/prompt/verdict) have no I/O so the server, CLI, and tests
// share them; runAcceptanceEvals takes an injectable evaluator so it is testable
// without spawning real agents.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { agentInvocation } from './providers.mjs';

// A single agent invocation may run this long before it's treated as stuck.
// Evals build + run tests, so give more headroom than a plain agent call.
const DEFAULT_EVAL_TIMEOUT_MS = 30 * 60 * 1000;
export function evalTimeoutMs() {
  const env = Number(process.env.PLANFORGE_EVAL_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_EVAL_TIMEOUT_MS;
}

const SLICE_HEADER = /^-\s+\*\*([a-z0-9][a-z0-9-]*)\s+[—–-]\s+(.+?)\*\*\s*$/;
const ACCEPTANCE_LINE = /^-\s*acceptance:\s*(.+?)\s*$/i;
const STATUS_LINE = /^-\s*status:\s*([a-z0-9][\w-]*)\s*$/i;
const BLOCK_BOUNDARY = /^(#{1,6}\s|-\s+\*\*)/; // next heading or next slice header

// Parse a build plan's §4 slice blocks into their acceptance criteria.
// Returns [{ id, title, status, criteria: string[] }] for every slice that
// declares at least one `acceptance:` line. A slice may list several.
export function parseAcceptanceCriteria(md) {
  const lines = String(md ?? '').split('\n');
  const slices = [];
  let current = null;
  const flush = () => { if (current && current.criteria.length) slices.push(current); current = null; };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const header = raw.match(SLICE_HEADER);
    if (header) {
      flush();
      current = { id: header[1], title: header[2].trim(), status: null, criteria: [] };
      continue;
    }
    if (!current) continue;
    const trimmed = raw.trim();
    // A new top-level heading ends the current slice; a nested bullet does not.
    if (/^#{1,6}\s/.test(trimmed)) { flush(); continue; }
    const acc = trimmed.match(ACCEPTANCE_LINE);
    if (acc) { current.criteria.push(acc[1].trim()); continue; }
    const st = trimmed.match(STATUS_LINE);
    if (st && !current.status) current.status = st[1].toLowerCase();
  }
  flush();
  return slices;
}

// Where a slice's verdict file lives. The evaluator writes here; we read it.
export function verdictPath(logDir, sliceId) {
  return join(logDir, `${String(sliceId).replace(/[^\w.-]/g, '_')}.verdict.json`);
}

// The evaluator prompt: skeptical, evidence-driven, and self-contained. It
// tells the agent to prove each criterion by execution (not by reading code),
// add a repeatable test for anything uncovered, and write a strict verdict.
export function buildEvalPrompt({ slice, verdictFile }) {
  const criteria = slice.criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
  return `You are an INDEPENDENT ACCEPTANCE EVALUATOR. You did not build this feature; do not trust that it works. Your job is to PROVE — with concrete evidence — whether the slice below actually satisfies each acceptance criterion, and to leave behind a repeatable automated test for each one so the guarantee holds in CI.

SLICE
- id: ${slice.id}
- title: ${slice.title || ''}

ACCEPTANCE CRITERIA (each must be independently proven):
${criteria}

HOW TO EVALUATE (do the work; do not shortcut):
1. Establish a baseline: install deps if needed, run the project's build, and run its test suite. Note what passes.
2. For EACH criterion, determine whether it is genuinely met by EXERCISING it — run the relevant test, invoke the command it names, drive the code path, or check the file/output it specifies. Reading the source and assuming it works is NOT acceptance.
3. If a criterion is not already covered by an automated test, ADD a focused, repeatable test that encodes it (unit/integration/e2e as appropriate for the stack), and run it. A criterion counts as "met" only when you have run something that proves it AND, where feasible, a committed test now asserts it.
4. Do NOT edit feature/production code to force a pass. You may only add or adjust TESTS and test scaffolding. If a criterion genuinely fails or cannot be proven, mark it not met and describe the exact gap — a failing eval is a correct and valuable outcome, not something to paper over.
5. Be adversarial: probe the unhappy paths and the boundaries the criterion implies, not just the happy path.

OUTPUT (required): write a JSON verdict to this exact absolute path:
${verdictFile}

with this shape:
{
  "sliceId": "${slice.id}",
  "status": "pass" | "fail",              // "pass" only if EVERY criterion is met
  "criteria": [ { "text": "<the criterion>", "met": true|false, "evidence": "<what you ran and observed — command + result, test name, output>" } ],
  "testsAdded": [ "<repo-relative path of each test file you added or extended>" ],
  "notes": "<anything the maintainer must know; for any not-met criterion, the concrete gap>"
}

Also print that same JSON to stdout on one line prefixed with "@eval-verdict ". Write the file even if you conclude fail. Commit any tests you added on the current branch.`;
}

// Pull a verdict object out of freeform agent stdout (fallback when the file
// is missing): the last "@eval-verdict {json}" line wins.
export function parseVerdict(text) {
  const matches = [...String(text ?? '').matchAll(/@eval-verdict\s+(\{.*\})\s*$/gm)];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(matches[i][1]); } catch { /* try the next */ }
  }
  return null;
}

export function readVerdict(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// Turn a raw verdict (from file or stdout) into a normalized result. A slice
// passes only when a well-formed verdict says pass AND every listed criterion
// is met AND it covers at least as many criteria as the slice declared. A
// missing/garbled verdict is an ERROR (treated as not passed) — the eval did
// not actually prove anything.
export function normalizeResult(slice, verdict, raw = {}) {
  const base = {
    sliceId: slice.id,
    title: slice.title || '',
    total: slice.criteria.length,
    met: 0,
    testsAdded: [],
    evidence: [],
    notes: '',
    exitCode: raw.code ?? null,
  };
  if (!verdict || typeof verdict !== 'object') {
    return { ...base, status: 'error', notes: 'evaluator produced no parseable verdict' };
  }
  const crit = Array.isArray(verdict.criteria) ? verdict.criteria : [];
  const met = crit.filter((c) => c && c.met === true).length;
  const allMet = crit.length >= slice.criteria.length && crit.length > 0 && met === crit.length;
  const claimedPass = verdict.status === 'pass';
  const status = claimedPass && allMet ? 'pass' : 'fail';
  return {
    ...base,
    status,
    met,
    total: Math.max(slice.criteria.length, crit.length),
    testsAdded: Array.isArray(verdict.testsAdded) ? verdict.testsAdded : [],
    evidence: crit.map((c) => ({ text: c?.text ?? '', met: c?.met === true, evidence: c?.evidence ?? '' })),
    notes: typeof verdict.notes === 'string' ? verdict.notes : '',
  };
}

// Run acceptance evals for a set of slices. `runEvaluator(slice, ctx)` is
// injectable — it must run the evaluator (writing the verdict file at
// ctx.verdictFile) and return { code, stdout, stderr }. Returns a report.
export async function runAcceptanceEvals({ slices, repoDir, logDir, runEvaluator, emit = () => {} }) {
  mkdirSync(logDir, { recursive: true });
  const results = [];
  for (const slice of slices) {
    const verdictFile = verdictPath(logDir, slice.id);
    try { rmSync(verdictFile, { force: true }); } catch { /* fresh */ }
    const prompt = buildEvalPrompt({ slice, verdictFile });
    emit('eval-start', { sliceId: slice.id, criteria: slice.criteria.length });
    let raw;
    try {
      raw = await runEvaluator(slice, { prompt, verdictFile, repoDir, logDir });
    } catch (err) {
      raw = { code: 1, stdout: '', stderr: String(err && err.message ? err.message : err) };
    }
    const verdict = readVerdict(verdictFile) || parseVerdict(raw && raw.stdout);
    const result = normalizeResult(slice, verdict, raw || {});
    results.push(result);
    emit('eval-result', { sliceId: slice.id, status: result.status, met: result.met, total: result.total });
  }
  const failed = results.filter((r) => r.status !== 'pass');
  return { total: results.length, passed: results.length - failed.length, failed: failed.length, results };
}

// A real evaluator backed by an agent provider. Spawns the provider's agent
// wrapper (which chdirs to the repo and reads the prompt on stdin), capturing
// stdout so a verdict printed there is a fallback to the file.
export function makeAgentEvaluator({ provider, env = process.env, spawn = spawnSync } = {}) {
  const inv = agentInvocation(provider);
  if (!inv) throw new Error(`No agent wrapper for provider "${provider}" — cannot run evals with it.`);
  return (slice, { prompt, repoDir }) => {
    const r = spawn(inv[0], [...inv.slice(1), repoDir], {
      input: prompt,
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      timeout: evalTimeoutMs(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

// One-line-per-slice human summary of a report.
export function summarizeEvalReport(report) {
  const icon = { pass: '✔', fail: '✖', error: '⚠' };
  const lines = report.results.map(
    (r) => `  ${icon[r.status] || '?'} ${r.sliceId}  (${r.met}/${r.total} criteria)${r.status !== 'pass' && r.notes ? ` — ${r.notes.split('\n')[0].slice(0, 120)}` : ''}`,
  );
  return `${report.passed}/${report.total} slices acceptance-verified${report.failed ? `, ${report.failed} failed` : ''}\n${lines.join('\n')}`;
}
