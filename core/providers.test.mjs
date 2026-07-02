// Unit tests for config-driven provider selection + reactive exhaustion detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  selectRoles,
  isForcedSameProvider,
  detectExhaustedProviders,
  agentScriptFor,
  providerHasAgent,
  AGENTS_DIR,
} from './providers.mjs';

// A three-provider policy (the historical default this module descends from):
// builder codex > glm > claude, reviewer claude > codex > glm, only claude dual.
const THREE = {
  builderPriority: ['codex', 'glm', 'claude'],
  reviewerPriority: ['claude', 'codex', 'glm'],
  dualRoleAllowed: ['claude'],
};

test('selectRoles — the three-provider policy table', () => {
  assert.deepEqual(selectRoles(['codex', 'glm', 'claude'], THREE), { builder: 'codex', reviewer: 'claude' });
  assert.deepEqual(selectRoles(['glm', 'claude'], THREE), { builder: 'glm', reviewer: 'claude' });
  assert.deepEqual(selectRoles(['codex', 'glm'], THREE), { builder: 'codex', reviewer: 'glm' });
  assert.deepEqual(selectRoles(['claude'], THREE), { builder: 'claude', reviewer: 'claude' }, 'claude may fill both roles');
  assert.deepEqual(selectRoles(['glm'], THREE), { builder: 'glm', reviewer: 'glm' }, 'forced same-provider fallback');
  assert.deepEqual(selectRoles([], THREE), { builder: null, reviewer: null });
  assert.deepEqual(selectRoles(['claude', 'glm'], THREE), { builder: 'glm', reviewer: 'claude' });
});

test('selectRoles — the default two-provider config', () => {
  const cfg = { builderPriority: ['codex', 'claude'], reviewerPriority: ['claude', 'codex'] };
  assert.deepEqual(selectRoles(['codex', 'claude'], cfg), { builder: 'codex', reviewer: 'claude' });
  assert.deepEqual(selectRoles(['claude'], cfg), { builder: 'claude', reviewer: 'claude' });
  assert.deepEqual(selectRoles(['codex'], cfg), { builder: 'codex', reviewer: 'codex' }, 'forced (codex is not dual-role)');
});

test('selectRoles — dualRoleAllowed is configurable, not hardcoded to claude', () => {
  const cfg = {
    builderPriority: ['mistral', 'claude'],
    reviewerPriority: ['mistral', 'claude'],
    dualRoleAllowed: ['mistral'],
  };
  assert.deepEqual(selectRoles(['mistral'], cfg), { builder: 'mistral', reviewer: 'mistral' });
  assert.equal(isForcedSameProvider({ builder: 'mistral', reviewer: 'mistral' }, ['mistral']), false);
  assert.equal(isForcedSameProvider({ builder: 'claude', reviewer: 'claude' }, ['mistral']), true, 'claude loses dual-role when not listed');
  // With both available, the reviewer still prefers a distinct provider only per
  // priority order: mistral is dual-role-allowed AND first in reviewer priority.
  assert.deepEqual(selectRoles(['mistral', 'claude'], cfg), { builder: 'mistral', reviewer: 'mistral' });
});

test('selectRoles — custom provider names from config work end-to-end', () => {
  const cfg = {
    builderPriority: ['my-local-llm', 'codex'],
    reviewerPriority: ['claude', 'my-local-llm'],
  };
  assert.deepEqual(selectRoles(['my-local-llm', 'claude'], cfg), { builder: 'my-local-llm', reviewer: 'claude' });
});

test('isForcedSameProvider flags only non-dual-role double-use (default list)', () => {
  assert.equal(isForcedSameProvider({ builder: 'glm', reviewer: 'glm' }), true);
  assert.equal(isForcedSameProvider({ builder: 'claude', reviewer: 'claude' }), false);
  assert.equal(isForcedSameProvider({ builder: 'codex', reviewer: 'claude' }), false);
  assert.equal(isForcedSameProvider({ builder: null, reviewer: null }), false);
});

test('detectExhaustedProviders — attributes errors to the right provider, scoped to in-use', () => {
  assert.deepEqual(
    detectExhaustedProviders('{"error":{"code":"1113","message":"Insufficient balance or no resource package"}}', ['glm', 'claude']),
    ['glm']
  );
  assert.deepEqual(
    detectExhaustedProviders('Error: 429 insufficient_quota — you exceeded your current quota', ['codex', 'claude']),
    ['codex']
  );
  assert.deepEqual(detectExhaustedProviders('API Error: credit balance is too low', ['glm', 'claude']), ['claude']);
  assert.deepEqual(
    detectExhaustedProviders("You've hit your monthly spend limit · raise it at claude.ai/settings/usage", ['glm', 'claude']),
    ['claude']
  );
  assert.deepEqual(
    detectExhaustedProviders('429 Too Many Requests from https://api.z.ai/api/anthropic', ['glm', 'claude']),
    ['glm']
  );
  assert.deepEqual(detectExhaustedProviders('insufficient balance code 1113', ['codex', 'claude']), [], 'glm signature but glm not in use');
  assert.deepEqual(detectExhaustedProviders('Done after 1 iteration. PR ready.', ['glm', 'claude']), [], 'clean log');
  assert.deepEqual(detectExhaustedProviders('', ['claude']), []);
});

test('agentScriptFor maps any provider name to core/agents/agent-<name>.sh', () => {
  assert.equal(agentScriptFor('claude'), join(AGENTS_DIR, 'agent-claude.sh'));
  assert.equal(agentScriptFor('codex'), join(AGENTS_DIR, 'agent-codex.sh'));
  assert.equal(agentScriptFor('my-local-llm'), join(AGENTS_DIR, 'agent-my-local-llm.sh'));
  assert.throws(() => agentScriptFor(''), /Invalid provider name/);
  assert.throws(() => agentScriptFor('../evil'), /Invalid provider name/);
  assert.throws(() => agentScriptFor(null), /Invalid provider name/);
});

test('providerHasAgent reflects the bundled scripts', () => {
  assert.equal(providerHasAgent('claude'), true);
  assert.equal(providerHasAgent('codex'), true);
  assert.equal(providerHasAgent('definitely-not-a-provider'), false);
});
