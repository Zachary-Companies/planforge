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

export const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'agents');

const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]*$/i;

// Map a provider name from config to its agent wrapper script. Any name is
// allowed as long as it is a sane script-name fragment; whether the script
// actually exists is the caller's availability concern (see providerHasAgent).
export function agentScriptFor(name) {
  if (typeof name !== 'string' || !PROVIDER_NAME_RE.test(name)) {
    throw new Error(`Invalid provider name: ${JSON.stringify(name)} (expected e.g. "codex" or "claude")`);
  }
  return join(AGENTS_DIR, `agent-${name}.sh`);
}

export function providerHasAgent(name) {
  try {
    return existsSync(agentScriptFor(name));
  } catch {
    return false;
  }
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
