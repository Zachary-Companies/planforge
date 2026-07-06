// Shared helpers for the bundled Node agent wrappers. (The leading underscore
// keeps this file from ever being resolved as a provider — providers are
// agent-<name>.* only.)
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

// Is `cmd` runnable from PATH? (where/which, cross-platform.)
export function commandExists(cmd) {
  const probe = spawnSync(IS_WINDOWS ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return probe.status === 0;
}

// Spawn a CLI cross-platform. On Windows, npm-installed CLIs are .cmd shims
// that only cmd.exe can execute, so route through it; argument values here are
// simple tokens (model ids, flags) — prompts always travel on stdin.
export function spawnCli(cmd, args, options = {}) {
  if (IS_WINDOWS) {
    return spawn('cmd.exe', ['/c', cmd, ...args], { ...options, windowsVerbatimArguments: false });
  }
  return spawn(cmd, args, options);
}

// The Claude Code CLI, or the npx fallback when it isn't installed globally.
export function claudeCommand() {
  if (commandExists('claude')) return { cmd: 'claude', args: [] };
  return { cmd: 'npx', args: ['-y', '@anthropic-ai/claude-code@latest'] };
}

export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function chdirTo(dir) {
  if (dir) {
    try { process.chdir(dir); } catch { /* stay where we are, matching the old scripts */ }
  }
}

// Load ZAI_API_KEY from the environment or ~/.config/zai/env (KEY=VALUE lines,
// `export KEY=VALUE` allowed). Returns the key or null.
export function loadZaiKey() {
  if (process.env.ZAI_API_KEY) return process.env.ZAI_API_KEY;
  const envFile = join(homedir(), '.config', 'zai', 'env');
  if (!existsSync(envFile)) return null;
  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?ZAI_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/);
      if (m) return m[1];
    }
  } catch { /* unreadable — treated as absent */ }
  return null;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

// How long a single agent CLI invocation may run before it's treated as hung
// and killed. Without this an agent that wedges (a provider CLI that never
// returns) blocks its worker forever, which freezes the whole run: the
// orchestrator process stays alive but idle, the UI shows "running" with a
// frozen elapsed, and no slice ever completes. 20 minutes is well beyond a
// normal build/plan invocation; override with PLANFORGE_AGENT_TIMEOUT_MS
// (0 disables the watchdog).
const DEFAULT_AGENT_TIMEOUT_MS = 20 * 60 * 1000;

export function agentTimeoutMs(explicit) {
  if (explicit !== undefined) return explicit;
  const env = Number(process.env.PLANFORGE_AGENT_TIMEOUT_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return DEFAULT_AGENT_TIMEOUT_MS;
}

// Run the agent CLI streaming stdout live, capturing stderr (so a caller can
// inspect it for retry decisions), forwarding it on exit. Resolves exit code.
// A hung agent is killed after `timeoutMs` (SIGTERM, then SIGKILL if it clings
// on) and reported as exit 124 — the conventional "timed out" code — so the
// worker fails that slice and the pool moves on instead of wedging forever.
export function runStreaming(cmd, args, { input, env, timeoutMs } = {}) {
  return new Promise((resolveP) => {
    const child = spawnCli(cmd, args, { env: env || process.env, stdio: ['pipe', 'inherit', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    let hardKill = null;
    const limit = agentTimeoutMs(timeoutMs);
    const watchdog = limit > 0 ? setTimeout(() => {
      timedOut = true;
      const msg = `\n[agent] no response after ${Math.round(limit / 1000)}s — terminating the stuck agent.\n`;
      process.stderr.write(msg);
      stderr += msg;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      hardKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10_000);
    }, limit) : null;
    const clearTimers = () => { if (watchdog) clearTimeout(watchdog); if (hardKill) clearTimeout(hardKill); };
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimers();
      process.stderr.write(`${err.message}\n`);
      resolveP({ code: 127, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimers();
      if (stderr) process.stderr.write(stderr);
      resolveP({ code: timedOut ? 124 : (code ?? 1), stderr, timedOut });
    });
    child.stdin.end(input ?? '');
  });
}
