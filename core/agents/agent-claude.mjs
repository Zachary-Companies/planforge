#!/usr/bin/env node
// Builder/reviewer provider = Anthropic Claude via Claude Code. Node wrapper so
// it runs identically on macOS, Linux, and Windows. Reads the prompt on stdin,
// works in the directory given as argv[2]. Uses your normal Claude auth.
//
// Model: the orchestrator sets CLAUDE_CHAIN_MODEL / CLAUDE_CHAIN_FALLBACK_MODEL /
// CLAUDE_CHAIN_EFFORT from planforge.config.json "models". If the primary model
// is unavailable at runtime, the buffered prompt is replayed once against the
// fallback model.
import { commandExists, claudeCommand, readStdin, chdirTo, runStreaming } from './_shared.mjs';

const arg = process.argv[2];

if (arg === '--check') {
  if (commandExists('claude')) {
    console.log('ok: claude CLI on PATH');
    process.exit(0);
  }
  if (commandExists('npx')) {
    console.log('ok: claude via npx fallback (first run is slower)');
    process.exit(0);
  }
  console.log('claude CLI not found — install: npm install -g @anthropic-ai/claude-code, then run: claude  (to sign in)');
  process.exit(1);
}

chdirTo(arg);

const MODEL = process.env.CLAUDE_CHAIN_MODEL || 'claude-fable-5';
const FALLBACK = process.env.CLAUDE_CHAIN_FALLBACK_MODEL || 'claude-opus-4-8';
const EFFORT = process.env.CLAUDE_CHAIN_EFFORT || 'high';
const UNAVAILABLE_RE = /currently unavailable|is unavailable|model (is )?not available|no access to/i;

const payload = readStdin();
const { cmd, args } = claudeCommand();
// CLAUDE_CHAIN_STREAM_JSON=1: emit stream-json events so the caller can show
// live progress and extract the final result (the chain and the plan
// pipeline both render this).
const STREAM = process.env.CLAUDE_CHAIN_STREAM_JSON === '1'
  ? ['--output-format', 'stream-json', '--verbose']
  : [];
const argsFor = (model) => [...args, '-p', '--model', model, '--effort', EFFORT, ...STREAM, '--dangerously-skip-permissions'];

const first = await runStreaming(cmd, argsFor(MODEL), { input: payload });
if (first.code !== 0 && MODEL !== FALLBACK && UNAVAILABLE_RE.test(first.stderr)) {
  process.stderr.write(`agent-claude: model '${MODEL}' unavailable — retrying with '${FALLBACK}'.\n`);
  const second = await runStreaming(cmd, argsFor(FALLBACK), { input: payload });
  process.exit(second.code);
}
process.exit(first.code);
