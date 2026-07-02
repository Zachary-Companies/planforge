#!/usr/bin/env node
// Builder/reviewer provider = OpenAI via the Codex CLI. Node wrapper so it runs
// identically on macOS, Linux, and Windows. Reads the task prompt on stdin,
// works in the directory given as argv[2]. Uses your normal Codex auth. The
// orchestrator sets CODEX_CHAIN_MODEL / CODEX_CHAIN_EFFORT from config.
import { existsSync } from 'node:fs';
import { commandExists, readStdin, chdirTo, runStreaming } from './_shared.mjs';

const MAC_APP_CODEX = '/Applications/Codex.app/Contents/Resources/codex';
const codexCmd = () => (existsSync(MAC_APP_CODEX) ? MAC_APP_CODEX : 'codex');

const arg = process.argv[2];

if (arg === '--check') {
  if (existsSync(MAC_APP_CODEX) || commandExists('codex')) {
    console.log('ok: codex CLI found');
    process.exit(0);
  }
  console.log('codex CLI not found — install the Codex app or CLI, then sign in with your OpenAI account');
  process.exit(1);
}

chdirTo(arg);

const MODEL = process.env.CODEX_CHAIN_MODEL || 'gpt-5.5';
const EFFORT = process.env.CODEX_CHAIN_EFFORT || 'high';

const result = await runStreaming(codexCmd(), [
  'exec',
  '--model', MODEL,
  '-c', `model_reasoning_effort="${EFFORT}"`,
  '--dangerously-bypass-approvals-and-sandbox',
  '--skip-git-repo-check',
  '-',
], { input: readStdin() });
process.exit(result.code);
