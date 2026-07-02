#!/bin/sh
# Builder/reviewer provider = GLM (z.ai), driven by the Claude Code agent loop
# pointed at z.ai's Anthropic-compatible endpoint. Uses an ISOLATED config dir
# so the z.ai token never touches your real Claude login — both providers can
# run side by side in the same pool.
#
# Needs ZAI_API_KEY in the environment, or saved once in ~/.config/zai/env
# (a one-line file: ZAI_API_KEY=...). Model from GLM_CHAIN_MODEL (the
# orchestrator sets it from planforge.config.json "models.glm"), default glm-5.2.
[ -z "$ZAI_API_KEY" ] && [ -f "$HOME/.config/zai/env" ] && . "$HOME/.config/zai/env"

if [ "$1" = "--check" ]; then
  if ! command -v claude >/dev/null 2>&1 && ! command -v npx >/dev/null 2>&1; then
    echo "needs the Claude Code CLI as its driver — install: npm install -g @anthropic-ai/claude-code"
    exit 1
  fi
  if [ -z "$ZAI_API_KEY" ]; then
    echo "ZAI_API_KEY not set — get a key at z.ai, then: export ZAI_API_KEY=...  (or save it in ~/.config/zai/env)"
    exit 1
  fi
  echo "ok: z.ai key present, Claude Code driver found"
  exit 0
fi

[ -n "$1" ] && cd "$1" 2>/dev/null || true

export CLAUDE_CONFIG_DIR="${GLM_CLAUDE_CONFIG_DIR:-$HOME/.config/zai/claude-cfg}"
export ANTHROPIC_BASE_URL="${GLM_BASE_URL:-https://api.z.ai/api/anthropic}"
export ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY"
mkdir -p "$CLAUDE_CONFIG_DIR"

CLAUDE="claude"
command -v claude >/dev/null 2>&1 || CLAUDE="npx -y @anthropic-ai/claude-code@latest"

# -p reads the task prompt from stdin (the chain pipes it in).
exec $CLAUDE -p --model "${GLM_CHAIN_MODEL:-glm-5.2}" --dangerously-skip-permissions
