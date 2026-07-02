# Agent providers

A **provider** is any CLI wrapped in a small script that PlanForge can use
to fill the *builder* or *reviewer* role (and the planner/reconcile steps, which
route through the builder slot).

## The provider contract

Every `agent-<name>.*` in this directory must:

1. **Read the prompt on stdin.** The whole task arrives as one stdin payload.
2. **Work in the directory given as the first argument.** The orchestrator
   passes the git worktree (or workspace) the agent should operate in as the
   first argument; `cd`/`process.chdir` into it before doing anything. If it
   is empty, stay in the current directory.
3. **Stream progress to stdout/stderr.** Output is captured to the run's
   transcript logs and scanned for quota/rate-limit signatures (see
   `core/providers.mjs`), so don't swallow error text.
4. **Exit 0 on success, non-zero on failure.** The exit code is the only
   success signal the chain trusts.
5. **Answer `--check` (recommended).** When invoked as `agent-<name>
   --check`, print ONE line and exit 0 if the provider is ready to use
   (CLI installed, credentials present), or print a one-line fix hint and
   exit non-zero. `planforge doctor`, the UI's agent status panel, and the
   orchestrator's startup health check all use this. Scripts without
   `--check` still work — the probe times out safely — but users get a
   worse setup experience.

The agent must be able to *act*, not just answer: it needs read/write access to
the working tree and permission to run `git`/`gh` (which is why the bundled
scripts pass their CLIs' respective "skip permissions/sandbox" flags — the
orchestrator already isolates each worker in its own worktree).

## Bundled providers

The bundled wrappers are **Node scripts** (`.mjs`), so they run identically on
macOS, Linux, and Windows — no shell required.

| Script | CLI | Setup | Model env vars (set by the orchestrator from `planforge.config.json` `models`) |
|---|---|---|---|
| `agent-claude.mjs` | `claude` (Claude Code) | `npm i -g @anthropic-ai/claude-code`, then `claude` once to sign in | `CLAUDE_CHAIN_MODEL`, `CLAUDE_CHAIN_FALLBACK_MODEL`, `CLAUDE_CHAIN_EFFORT` |
| `agent-codex.mjs` | `codex` | install the Codex app/CLI, sign in with your OpenAI account | `CODEX_CHAIN_MODEL`, `CODEX_CHAIN_EFFORT` |
| `agent-glm.mjs` | GLM 5.2 via z.ai (driven by Claude Code pointed at z.ai's Anthropic-compatible endpoint) | get a z.ai API key, then `export ZAI_API_KEY=...` or save it in `~/.config/zai/env` | `GLM_CHAIN_MODEL` |

`agent-claude.mjs` buffers the stdin prompt so that, when the configured model
is unavailable at runtime, it can replay the same prompt once against the
fallback model. `agent-glm.mjs` uses an isolated Claude Code config dir, so
your real Claude login is untouched — Claude and GLM can fill the two roles
side by side.

Run `planforge doctor` any time to see which providers are ready and which
roles they'd fill; the UI's run panel shows the same and lets you pick the
code writer and reviewer per run.

## Adding your own provider

1. Drop an `agent-<name>.mjs` (recommended — works on every platform, run via
   Node) or `agent-<name>.sh` (macOS/Linux; on Windows it runs through Git
   Bash) in this directory that honors the contract above. Windows-native
   `.cmd`/`.bat`/`.exe` also work. Keep `<name>` to letters/digits/`-`/`_`.
   Resolution order prefers `.mjs`.
2. List `<name>` in your `planforge.config.json`:

   ```json
   {
     "providers": {
       "builderPriority": ["<name>", "codex", "claude"],
       "reviewerPriority": ["claude", "<name>", "codex"]
     }
   }
   ```

3. Optionally add it to `providers.dualRoleAllowed` if it is strong enough to
   review its own builds (by default only `claude` may fill both roles).

Selection walks the priority lists and picks the first *available* provider for
each role (builder ≠ reviewer unless dual-role-allowed). A provider whose script
is missing is skipped; a provider that hits an out-of-credits / rate-limit error
mid-run is demoted for a cooldown and the pool fails over to the next one
automatically. If your provider's quota errors have distinctive text, consider
adding a signature for it in `core/providers.mjs` so failover can attribute
them.

Model/effort knobs for custom providers are up to you: read your own env vars in
the script, or hard-code them.
