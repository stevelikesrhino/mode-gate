# Cache compaction

Best-effort prompt-cache reuse for Pi compaction, with Pi's native summary as the fallback. Requires Pi 0.87.0 or later.

## Routing

Every non-Codex compaction starts here:

```text
Matching live capture → reuse its prefix
Missing, stale, or unverifiable capture → warn and reconstruct from saved state
Input/output limit → retain more recent history and retry a shorter prefix
Success → save summary
Failure or exhausted retries → Pi's native summary for this operation only
```

Fallback is never sticky: the next compaction tries the cache route again. There is no standalone chunked summarizer.

Cache reuse supports `openai-completions`, `openai-responses`, and `anthropic-messages`. Other APIs use Pi's native summary. Public OpenAI Responses uses text summaries, not Codex opaque checkpoints.

## Reconstruction and retries

- Reconstruction uses the selected model, Pi's context-edited history, previous summary, and saved system/tool state. It works immediately after reload, tree navigation, or a model switch; no live turn is required first.
- Saved prompt overrides are preserved. Unapplied model-specific prompt mappings and request-only extension transformations are not replayed. Reconstruction can therefore include saved content that a request-only transform would omit.
- Cache alignment is best effort. Unverifiable captures trigger a small cost warning and reconstruction, not cancellation. Provider cache hits are never guaranteed.
- Pi's original retained boundary is used initially. Limit retries double recent-history retention and move the cut earlier using the edited projection. Unchanged cuts are skipped; retries stop when no earlier valid cut remains.
- Summary requests use the model's output allowance. Each request has a 15-minute timeout; the cache/reconstruction phase has a 30-minute deadline. Pi's native fallback runs separately.
- History is append-only. Partial summaries are never saved, and user aborts do not start fallback. Successful cache recovery includes reported usage from its limit retries.

Pi owns manual/automatic compaction timing and branch summarization. Use normal `compaction` settings, including `modelOverrides`; legacy `pi-codex-compaction.json` is ignored.

## Codex safety

`openai-codex` with `openai-codex-responses` uses the native remote opaque-checkpoint adapter, with a five-minute request timeout. Failures cancel without text/native-summary fallback. Existing checkpoints from the original npm extension remain readable.

Opaque checkpoints cannot be translated into text. Wrong-model or malformed checkpoints, and edits targeting history already absorbed into them, fail closed. Post-checkpoint tail edits remain supported.

## Loading and verification

Load only `extensions/cache-compaction/index.ts`; do not also load `npm:@ogulcancelik/pi-codex-compaction`. Use `/reload` or restart after changes.

Offline checks from `~/.pi/agent`:

```sh
node extensions/cache-compaction/tests/text-compaction.mjs
node extensions/cache-compaction/tests/combined.mjs
PI_COMPACTION_STUB=1 node extensions/cache-compaction/tests/responses-cache-e2e.mjs
```

Set `PI_E2E_TOOLS=1` for historical tool-call coverage. Set `PI_ROOT` for a non-default Pi installation.

Optional live verification uses configured credentials and consumes provider quota, with synthetic data and isolated settings:

```sh
PI_LIVE_COMPACTION=1 node extensions/cache-compaction/tests/live.mjs deepseek deepseek-flash
```

Set `CC_DEBUG_LOG=/path/to/log.jsonl` before startup for diagnostics. Request bodies and authentication headers are not logged.

## Attribution and license

The code under `codex/` is derived from **Can Celik** ([ogulcancelik](https://github.com/ogulcancelik))'s **[@ogulcancelik/pi-codex-compaction](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction)**, version **0.1.5**. Local adaptations cover shared dispatch, authentication/timeout handling, context-edit replay, and status rendering; there is no runtime dependency on that npm package.

Copyright (c) 2025 Can Celik. The original MIT license is preserved in [`codex/LICENSE`](codex/LICENSE). Keep that notice and license with copies or substantial portions of the Codex code.
