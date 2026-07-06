import test from 'node:test';
import assert from 'node:assert/strict';
import { agentTimeoutMs, runStreaming } from './_shared.mjs';

test('agentTimeoutMs: explicit wins, then env, then the default', () => {
  assert.equal(agentTimeoutMs(500), 500);
  assert.equal(agentTimeoutMs(0), 0); // explicit disable is honored

  const prev = process.env.PLANFORGE_AGENT_TIMEOUT_MS;
  try {
    process.env.PLANFORGE_AGENT_TIMEOUT_MS = '1234';
    assert.equal(agentTimeoutMs(), 1234);
    process.env.PLANFORGE_AGENT_TIMEOUT_MS = '0'; // env can disable too
    assert.equal(agentTimeoutMs(), 0);
    delete process.env.PLANFORGE_AGENT_TIMEOUT_MS;
    assert.equal(agentTimeoutMs(), 20 * 60 * 1000); // falls back to the default
  } finally {
    if (prev === undefined) delete process.env.PLANFORGE_AGENT_TIMEOUT_MS;
    else process.env.PLANFORGE_AGENT_TIMEOUT_MS = prev;
  }
});

test('a hung agent is killed at the timeout and reported as exit 124', async () => {
  const started = Date.now();
  // a child that would otherwise run for a minute
  const result = await runStreaming(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    timeoutMs: 300,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.code, 124, 'timed-out agent reports the 124 exit code');
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /terminating the stuck agent/);
  assert.ok(elapsed < 5000, `killed promptly, not after the child's own 60s (took ${elapsed}ms)`);
});

test('an agent that finishes before the timeout returns its real exit code', async () => {
  const ok = await runStreaming(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 10_000 });
  assert.equal(ok.code, 0);
  assert.equal(ok.timedOut, false);

  const bad = await runStreaming(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 10_000 });
  assert.equal(bad.code, 3);
  assert.equal(bad.timedOut, false);
});

test('timeoutMs:0 disables the watchdog (a quick child still completes normally)', async () => {
  const ok = await runStreaming(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 0 });
  assert.equal(ok.code, 0);
  assert.equal(ok.timedOut, false);
});
