#!/usr/bin/env node
// Builder/reviewer provider = GLM (z.ai), driven by the Claude Code agent loop
// pointed at z.ai's Anthropic-compatible endpoint. Node wrapper so it runs
// identically on macOS, Linux, and Windows. Uses an ISOLATED config dir so the
// z.ai token never touches your real Claude login — both providers can run
// side by side in the same pool.
//
// Needs ZAI_API_KEY in the environment, or saved once in ~/.config/zai/env
// (a one-line file: ZAI_API_KEY=...). Model from GLM_CHAIN_MODEL (the
// orchestrator sets it from planforge.config.json "models.glm"), default glm-5.2.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandExists, claudeCommand, readStdin, chdirTo, ensureDir, loadZaiKey, runStreaming } from './_shared.mjs';

const arg = process.argv[2];
const key = loadZaiKey();

if (arg === '--check') {
  if (!commandExists('claude') && !commandExists('npx')) {
    console.log('needs the Claude Code CLI as its driver — install: npm install -g @anthropic-ai/claude-code');
    process.exit(1);
  }
  if (!key) {
    console.log('ZAI_API_KEY not set — get a key at z.ai, then: export ZAI_API_KEY=...  (or save it in ~/.config/zai/env)');
    process.exit(1);
  }
  console.log('ok: z.ai key present, Claude Code driver found');
  process.exit(0);
}

chdirTo(arg);

if (!key) {
  process.stderr.write('agent-glm: ZAI_API_KEY not set.\n');
  process.exit(1);
}

const configDir = process.env.GLM_CLAUDE_CONFIG_DIR || join(homedir(), '.config', 'zai', 'claude-cfg');
ensureDir(configDir);
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: configDir,
  ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
  ANTHROPIC_AUTH_TOKEN: key,
};

const MODEL = process.env.GLM_CHAIN_MODEL || 'glm-5.2';
const { cmd, args } = claudeCommand();
const result = await runStreaming(cmd, [...args, '-p', '--model', MODEL, '--dangerously-skip-permissions'], {
  input: readStdin(),
  env,
});
process.exit(result.code);
