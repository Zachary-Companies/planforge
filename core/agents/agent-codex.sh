#!/bin/sh
# Builder/reviewer provider = OpenAI via the Codex CLI. cd into the workdir ($1)
# and read the task prompt from stdin. Uses your normal Codex auth. The
# orchestrator sets CODEX_CHAIN_MODEL from planforge.config.json "models".
[ -n "$1" ] && cd "$1" 2>/dev/null || true
CODEX="/Applications/Codex.app/Contents/Resources/codex"
[ -x "$CODEX" ] || CODEX="codex"
exec "$CODEX" exec --model "${CODEX_CHAIN_MODEL:-gpt-5.5}" \
  -c "model_reasoning_effort=\"${CODEX_CHAIN_EFFORT:-high}\"" \
  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -
