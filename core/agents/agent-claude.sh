#!/bin/sh
# Builder/reviewer provider = Anthropic Claude via Claude Code. cd into the
# workdir ($1) and read the prompt from stdin. Uses your normal Claude auth
# (default config dir).
#
# Model: the orchestrator sets CLAUDE_CHAIN_MODEL / CLAUDE_CHAIN_FALLBACK_MODEL /
# CLAUDE_CHAIN_EFFORT from planforge.config.json "models". If the primary model
# is unavailable at runtime (access gated / rolled out), retry once with the
# fallback — the prompt is buffered from stdin so it can be replayed. stderr of
# the first attempt is deferred until it exits so the retry decision can
# inspect it.
if [ "$1" = "--check" ]; then
  if command -v claude >/dev/null 2>&1; then
    echo "ok: claude CLI on PATH"
    exit 0
  fi
  if command -v npx >/dev/null 2>&1; then
    echo "ok: claude via npx fallback (first run is slower)"
    exit 0
  fi
  echo "claude CLI not found — install: npm install -g @anthropic-ai/claude-code, then run: claude  (to sign in)"
  exit 1
fi

[ -n "$1" ] && cd "$1" 2>/dev/null || true
CLAUDE="claude"
command -v claude >/dev/null 2>&1 || CLAUDE="npx -y @anthropic-ai/claude-code@latest"
MODEL="${CLAUDE_CHAIN_MODEL:-claude-fable-5}"
FALLBACK="${CLAUDE_CHAIN_FALLBACK_MODEL:-claude-opus-4-8}"
EFFORT="${CLAUDE_CHAIN_EFFORT:-high}"

payload=$(cat)
errlog="${TMPDIR:-/tmp}/agent-claude-$$.stderr"
printf '%s' "$payload" | $CLAUDE -p --model "$MODEL" --effort "$EFFORT" --dangerously-skip-permissions 2>"$errlog"
code=$?
cat "$errlog" >&2
if [ $code -ne 0 ] && [ "$MODEL" != "$FALLBACK" ] && \
   grep -qiE 'currently unavailable|is unavailable|model (is )?not available|no access to' "$errlog"; then
  echo "agent-claude: model '$MODEL' unavailable — retrying with '$FALLBACK'." >&2
  printf '%s' "$payload" | $CLAUDE -p --model "$FALLBACK" --effort "$EFFORT" --dangerously-skip-permissions
  code=$?
fi
rm -f "$errlog"
exit $code
