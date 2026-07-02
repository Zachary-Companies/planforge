# Agent providers

A **provider** is any CLI wrapped in a small shell script that PlanForge can use
to fill the *builder* or *reviewer* role (and the planner/reconcile steps, which
route through the builder slot).

## The provider contract

Every `agent-<name>.sh` in this directory must:

1. **Read the prompt on stdin.** The whole task arrives as one stdin payload.
2. **Work in the directory given as `$1`.** The orchestrator passes the git
   worktree (or workspace) the agent should operate in as the first argument;
   `cd` into it before doing anything. If `$1` is empty, stay in the current
   directory.
3. **Stream progress to stdout/stderr.** Output is captured to the run's
   transcript logs and scanned for quota/rate-limit signatures (see
   `core/providers.mjs`), so don't swallow error text.
4. **Exit 0 on success, non-zero on failure.** The exit code is the only
   success signal the chain trusts.

The agent must be able to *act*, not just answer: it needs read/write access to
the working tree and permission to run `git`/`gh` (which is why the bundled
scripts pass their CLIs' respective "skip permissions/sandbox" flags — the
orchestrator already isolates each worker in its own worktree).

## Bundled providers

| Script | CLI | Model env vars (set by the orchestrator from `planforge.config.json` `models`) |
|---|---|---|
| `agent-claude.sh` | `claude` (Claude Code) | `CLAUDE_CHAIN_MODEL`, `CLAUDE_CHAIN_FALLBACK_MODEL`, `CLAUDE_CHAIN_EFFORT` |
| `agent-codex.sh` | `codex` | `CODEX_CHAIN_MODEL`, `CODEX_CHAIN_EFFORT` |

`agent-claude.sh` buffers the stdin prompt so that, when the configured model is
unavailable at runtime, it can replay the same prompt once against the fallback
model.

## Adding your own provider

1. Drop an executable `agent-<name>.sh` in this directory that honors the
   contract above (`chmod +x` it). Keep `<name>` to letters/digits/`-`/`_`.
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
