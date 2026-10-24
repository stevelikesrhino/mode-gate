# ccc-evo — Cache Compaction Codex Evo

Best-effort prompt-cache reuse for Pi compaction, native Codex checkpoints, OpenAI priority service, and subscription usage.

## Loading

Load `extensions/ccc-evo/index.ts`; it replaces the separate `cache-compaction` and `pi-openai` extensions. Do not also load `npm:@ogulcancelik/pi-codex-compaction`. Use `/reload` or restart after changes.

## Commands

- `/fast [on|off|status]`: toggle priority service, set it explicitly, or inspect the current setting. With no argument, `/fast` toggles. The TUI model label turns red while Fast is active.
- `/usage`: open subscription limits in the TUI. Requires Codex OAuth (`/login openai-codex`). Press `r` to refresh or `Esc` to close; there is no background polling.

Fast adds `service_tier: "priority"` only for `openai` and `openai-codex` models using `openai-completions`, `openai-responses`, or `openai-codex-responses`. It covers normal replies, compaction and native fallback, `/tree` summaries, bug-report summaries, and cache warming through Pi's model runtime, plus this extension's direct compaction requests. Unrelated direct `fetch` or bare `pi-ai` calls bypass it.

The live setting is read after existing payload hooks. `/fast off` stops adding priority; it does not change in-flight requests or remove explicit tiers supplied by other callers. Priority may increase costs or quota usage; the server decides whether to grant it.

Fast is not persisted: startup, resume, reload, and session changes reset it to off. Model switches and tree navigation retain the setting; unsupported providers remain unaffected.

Fast depends on Pi 1.3's private `ModelRuntime.prepareRequest` interface. SDK sessions need separate model runtimes: sharing one between active `ccc-evo` sessions disables Fast for that runtime until it is replaced.

## Routing

Text compaction supports `openai-completions`, `openai-responses`, and `anthropic-messages`:

```text
Matching live capture → reuse its prefix
Missing, stale, or unverifiable capture → warn and reconstruct from saved state
Input/output limit → retain more recent history and retry a shorter prefix
Success → save summary
Failure or exhausted retries → Pi's native summary for this operation only
```

Fallback applies only to that operation; the next compaction tries the cache route again. Other non-Codex APIs use Pi's native summary. Public OpenAI Responses uses text summaries, not Codex opaque checkpoints.

## Reconstruction and retries

- Reconstruction uses the selected model, Pi's context-edited history, previous summary, and saved system/tool state. No live turn is required after reload, tree navigation, or a model switch if the saved state is available; missing prompt state uses Pi's native fallback.
- Saved prompt overrides are preserved. Unapplied model-specific prompt mappings and request-only extension transformations are not replayed. Reconstruction can therefore include saved content that a request-only transform would omit.
- Unverifiable captures warn and reconstruct instead of cancelling. Provider cache hits are not guaranteed.
- Pi's original retained boundary is used initially. Limit retries double recent-history retention and move the cut earlier using the edited projection. Unchanged cuts are skipped; retries stop when no earlier valid cut remains.
- Summary requests use the model's output allowance. Each request has a 15-minute timeout; the cache/reconstruction phase has a 30-minute deadline. Pi's native fallback runs separately.
- History is append-only. Partial summaries are never saved, and user aborts do not start fallback. Successful cache recovery includes reported usage from its limit retries.

Pi owns manual/automatic compaction timing and branch summarization. Use normal `compaction` settings, including `modelOverrides`; legacy `pi-codex-compaction.json` is ignored.

## Codex safety

`openai-codex` with `openai-codex-responses` uses the native remote opaque-checkpoint adapter, with a five-minute request timeout. Failures cancel without text/native-summary fallback. Existing checkpoints from the original npm extension remain readable.

Cross-model replay requires known matching `comp_hash` values from the [model catalog](codex/native-compaction.ts) and preserves encrypted reasoning and associated item IDs. New checkpoints save the source hash; legacy checkpoints infer it from the catalog.

Opaque checkpoints cannot be translated into text. Incompatible or malformed checkpoints, and edits targeting history already absorbed into them, cancel the operation. Post-checkpoint tail edits remain supported.

## Development

Offline checks from `~/.pi/agent`:

```sh
node extensions/ccc-evo/tests/text-compaction.mjs
node extensions/ccc-evo/tests/combined.mjs
node extensions/ccc-evo/tests/codex-retention.mjs
node --test extensions/ccc-evo/openai/tests/core.test.mjs
PI_COMPACTION_STUB=1 node extensions/ccc-evo/tests/responses-cache-e2e.mjs
```

Set `PI_E2E_TOOLS=1` for historical tool-call coverage. Set `PI_ROOT` for a non-default Pi installation.

Optional live verification uses configured credentials and consumes provider quota, with synthetic data and isolated settings:

```sh
PI_LIVE_COMPACTION=1 node extensions/ccc-evo/tests/live.mjs deepseek deepseek-flash
```

Set `CC_DEBUG_LOG=/path/to/log.jsonl` before startup for diagnostics. Request bodies and authentication headers are not logged.

## Attribution and license

The code under `codex/` is derived from **Can Celik** ([ogulcancelik](https://github.com/ogulcancelik))'s **[@ogulcancelik/pi-codex-compaction](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction)**, version **0.1.5**. There is no runtime dependency on that npm package.

Copyright (c) 2025 Can Celik. The original MIT license is preserved in [`codex/LICENSE`](codex/LICENSE). Keep that notice and license with copies or substantial portions of the Codex code.
