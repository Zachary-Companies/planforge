// Dynamic provider selection for the PlanForge orchestrator.
//
// A provider is any stdin-reading agent wrapper that can fill EITHER role
// (builder or reviewer). Provider names are config-driven: a provider called
// "<name>" maps to the executable core/agents/agent-<name>.sh (users add their
// own by dropping a script there and listing the name in
// planforge.config.json's providers.builderPriority / reviewerPriority).
//
// Selection policy (from config):
//   builder:  first available name in providers.builderPriority
//   reviewer: first available name in providers.reviewerPriority
//   builder and reviewer must be DIFFERENT providers, EXCEPT providers listed
//   in providers.dualRoleAllowed (default: ["claude"]) may fill both roles.
//
// Availability is decided reactively: a provider that returns an
// out-of-credits / rate-limit error is marked exhausted (with a cooldown) and
// dropped from selection until it recovers.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { IS_WINDOWS, findPosixShell } from './platform.mjs';

export const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'agents');

const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]*$/i;

// Agent wrapper lookup order. The bundled wrappers are Node scripts (.mjs) so
// they run on every platform; custom providers may be .sh (run through the
// POSIX shell — Git Bash on Windows) or native .cmd/.bat/.exe on Windows.
const AGENT_EXTENSIONS = IS_WINDOWS
  ? ['.mjs', '.cmd', '.bat', '.exe', '.sh']
  : ['.mjs', '.sh'];

function assertProviderName(name) {
  if (typeof name !== 'string' || !PROVIDER_NAME_RE.test(name)) {
    throw new Error(`Invalid provider name: ${JSON.stringify(name)} (expected e.g. "codex" or "claude")`);
  }
}

// Resolve a provider name to its agent wrapper file, or null when none exists.
// `dir` is overridable for tests.
export function resolveAgent(name, dir = AGENTS_DIR) {
  assertProviderName(name);
  for (const ext of AGENT_EXTENSIONS) {
    const path = join(dir, `agent-${name}${ext}`);
    if (existsSync(path)) return { path, ext };
  }
  return null;
}

// The argv to execute an agent wrapper cross-platform: Node scripts through
// this Node, .sh through the POSIX shell, native executables directly.
export function agentInvocation(name, dir = AGENTS_DIR) {
  const agent = resolveAgent(name, dir);
  if (!agent) return null;
  if (agent.ext === '.mjs') return [process.execPath, agent.path];
  if (agent.ext === '.sh') {
    const shell = findPosixShell();
    return shell ? [shell, agent.path] : null;
  }
  return [agent.path];
}

// The agent wrapper's path (first match), or the .mjs path it WOULD have —
// kept for callers that only display/derive names from it.
export function agentScriptFor(name) {
  assertProviderName(name);
  const agent = resolveAgent(name);
  return agent ? agent.path : join(AGENTS_DIR, `agent-${name}.mjs`);
}

export function providerHasAgent(name) {
  try {
    return agentInvocation(name) !== null;
  } catch {
    return false;
  }
}

// POSIX-shell single-quoting (the composed command always runs through the
// POSIX shell — /bin/sh, or Git Bash on Windows — never cmd.exe).
function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The agent invocation as a shell-command prefix for the chain's role slots,
// e.g. "'/usr/bin/node' '/…/agent-claude.mjs'". Append args like '{workspace}'.
export function agentCommandString(name) {
  const argv = agentInvocation(name);
  return argv ? argv.map(q).join(' ') : null;
}

// Health-check a provider by running its agent script with --check (part of the
// provider contract: print one line and exit 0 when usable, non-0 with a
// human-readable fix hint otherwise). Scripts that predate --check are guarded
// by the timeout: stdin is closed, so a script that starts its agent anyway
// sees EOF and exits quickly. Returns { name, available, detail }.
export function checkProvider(name, { runScript } = {}) {
  let argv;
  try {
    argv = agentInvocation(name);
  } catch (e) {
    return { name, available: false, detail: e.message };
  }
  if (!argv) {
    const missing = resolveAgent(name) === null;
    return {
      name,
      available: false,
      detail: missing
        ? `agent wrapper missing: ${join(AGENTS_DIR, `agent-${name}.*`)}`
        : `agent-${name}.sh needs a POSIX shell — on Windows install Git for Windows (bundled bash), or set PLANFORGE_SHELL`,
    };
  }
  const run = runScript || ((cmdArgv) =>
    spawnSync(cmdArgv[0], [...cmdArgv.slice(1), '--check'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const r = run(argv);
  const firstLine = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n')[0].trim();
  if ((r.status ?? -1) === 0) {
    return { name, available: true, detail: firstLine.replace(/^ok:\s*/i, '') || 'ok' };
  }
  return { name, available: false, detail: firstLine || `agent-${name}.sh --check failed` };
}

// Pick the (builder, reviewer) pair from the set of currently-available
// providers, honoring the config-driven priorities and the "distinct unless
// dual-role-allowed" constraint. `available` is an array/Set of provider names.
// Returns { builder, reviewer } or { builder: null, reviewer: null } when
// nothing is available.
export function selectRoles(available, { builderPriority, reviewerPriority, dualRoleAllowed = ['claude'] }) {
  const ok = new Set(available);
  const dual = new Set(dualRoleAllowed);
  const builder = builderPriority.find((p) => ok.has(p)) || null;
  if (!builder) return { builder: null, reviewer: null };
  // Reviewer: highest-priority available provider that is either different from
  // the builder, or is allowed to fill both roles.
  let reviewer = reviewerPriority.find((p) => ok.has(p) && (p !== builder || dual.has(p)));
  // Forced fallback: only one provider available and it's not dual-role-allowed —
  // reuse it rather than not running (caller should warn; see isForcedSameProvider).
  if (!reviewer) reviewer = reviewerPriority.find((p) => ok.has(p)) || builder;
  return { builder, reviewer };
}

// True when builder and reviewer are the same provider without dual-role
// permission — i.e. the policy had to be violated because nothing else was
// available.
export function isForcedSameProvider({ builder, reviewer }, dualRoleAllowed = ['claude']) {
  return !!builder && builder === reviewer && !dualRoleAllowed.includes(builder);
}

// Per-provider substrings that signal the account is out of budget /
// rate-limited. Matched case-insensitively against a worker's combined
// stdout/stderr log. Providers without an entry here are never demoted by
// signature (only by an explicit host hint below).
const EXHAUSTION_SIGNATURES = {
  glm: [
    'insufficient balance', 'no resource package', '"1113"', 'code":"1113"',
    'quota has been used up', 'api.z.ai', // z.ai 429s reference its host
  ],
  codex: [
    'insufficient_quota', 'exceeded your current quota', 'billing_hard_limit_reached',
    'you exceeded your current quota', 'account is not active',
  ],
  claude: [
    'credit balance is too low', 'rate_limit_error', 'this organization has been disabled',
    'usage limit reached', 'overloaded_error',
    // Console / subscription account caps (observed in real runs):
    'spend limit', 'monthly spend limit', 'claude.ai/settings/usage',
    'reached your usage limit', "you've reached your", 'upgrade to increase your usage',
  ],
};

// Generic 429 phrasing -> attribute by the API host that appears nearby.
const HOST_HINTS = { 'api.z.ai': 'glm', 'api.openai.com': 'codex', 'api.anthropic.com': 'claude' };

// Inspect a finished worker's log and return the list of providers that appear
// to have hit an out-of-credits / rate-limit wall. `inUse` (the providers that
// worker actually ran) scopes attribution so an unrelated string never demotes
// a provider that wasn't even used.
export function detectExhaustedProviders(logText, inUse) {
  const text = String(logText || '').toLowerCase();
  const scope = new Set(inUse || Object.keys(EXHAUSTION_SIGNATURES));
  const hit = new Set();
  for (const [provider, sigs] of Object.entries(EXHAUSTION_SIGNATURES)) {
    if (!scope.has(provider)) continue;
    if (sigs.some((s) => text.includes(s.toLowerCase()))) hit.add(provider);
  }
  // Generic rate-limit / 429 attributed to a provider only if its host is mentioned.
  if (/\b429\b|rate limit|too many requests/.test(text)) {
    for (const [host, provider] of Object.entries(HOST_HINTS)) {
      if (scope.has(provider) && text.includes(host)) hit.add(provider);
    }
  }
  return [...hit];
}
