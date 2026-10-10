# Cache compaction

One pi extension for two compaction paths. It never hands failed compaction to Pi's native summarizer:

| Model/provider | Compaction | Failure behavior |
| --- | --- | --- |
| `openai-codex` with `openai-codex-responses` | Codex remote opaque checkpoint | Cancel; preserve existing history |
| Non-Codex providers using `openai-completions`, `openai-responses`, or `anthropic-messages` | Cache-aligned text summary | Cancel; preserve existing history |
| Unsupported APIs | No compaction | Cancel |

Public OpenAI Responses uses ordinary text summaries, not the remote opaque Codex endpoint.

## Behavior

Requires pi 0.87.0 or later. Pi owns manual, threshold, overflow, and between-turn compaction timing and branch summarization. Tree navigation only invalidates the text path's captured request.

The text path preserves pi's `firstKeptEntryId`, including `keepRecentTokens` and split-turn cut selection. It summarizes the history and turn prefix together in one request. Captured provider message content is reused without changing tool selection. Missing capture is reconstructed through the provider SDK using Pi's full edited projection, the selected conversation prefix, and all saved system/prompt/tool state. The cut limits conversation, not request configuration. Saved model-system-prompt overrides (including `CODEX.md`) survive reconstruction; the idle prompt getter is not substituted for them. A model switch with no subsequent live response cancels reconstruction rather than guessing an unapplied mapping. Incomplete captures and divergent captured history cancel rather than reconstructing around unknown transforms.

Reconstruction deliberately does not replay request-only extension context/header/payload transformations. It can include saved content or schemas those hooks normally omit; this is an accepted local supervised-agent trade-off. Exact cache reuse is not guaranteed. Provider authentication and serialization still use the current SDK. No warm-up probe is sent. If truncation removes an Anthropic conversation cache breakpoint, its TTL and cache policy move to the last eligible retained block. SDK-only beta/profile parameters are translated into HTTP headers; OAuth and Copilot credentials use bearer authentication. Unknown wire mappings or divergent history cancel compaction. Limit failures retain the existing sliding-window backoff: double recent-history retention, move the cut earlier, raise the supported summary output allowance, and retry up to four times under one five-minute deadline. Successful recovery includes cumulative usage. Exhausted or unsafe recovery cancels without starting another summarizer. Cache reads depend on the provider's serialization, cache availability, and breakpoints; they are not guaranteed for every supported API shape.

The Codex path preserves upstream's opaque checkpoint format and replay rules, so sessions created by the npm extension remain readable. Its remote replacement history has its own recent-user-message retention policy, distinct from the text path's retained tail. It fails closed if a checkpoint is malformed or belongs to another Codex model. Switching providers cannot translate opaque history into text; only surviving pi messages remain available to other providers. Local Codex checkpoint markers are filtered from live context.

Use Pi's normal compaction settings, including `compaction.modelOverrides`. Legacy `pi-codex-compaction.json` settings are no longer read.

Codex replay honors append-only context edits in the post-checkpoint tail. Edits targeting history already absorbed into an opaque checkpoint fail closed. Text compaction uses Pi's projected preparation; if a limit failure requires a new cut on a branch containing context edits, it cancels rather than reconstructing an edit-unaware boundary. Opaque Codex checkpoints block all text compaction paths.

## Loading and migration

Load only `extensions/cache-compaction/index.ts`. Do not also load `npm:@ogulcancelik/pi-codex-compaction`, or both copies will register hooks.

The migration removes the npm source from `settings.json` while leaving its installed files untouched. Existing processes need `/reload` or a restart. Compaction immediately after reload/resume reconstructs from saved prompt/history when possible. Without saved system state, or after an unapplied model switch, make a live request before retrying. Cancellation is not a blanket agent abort: Pi may continue a proactive-threshold request with uncompacted context; failed overflow compaction does not trigger compact-and-retry continuation.

Set `CC_DEBUG_LOG=/path/to/log.jsonl` before startup to enable text-path diagnostics. Logging is off by default. Request bodies and authentication headers are not logged.

## Tests

Required offline checks from `~/.pi/agent`:

```sh
node extensions/cache-compaction/tests/text-compaction.mjs
node extensions/cache-compaction/tests/combined.mjs
```

These check prefix and header safety, fail-closed errors, limit recovery, capture lifecycle, saved-state reconstruction, dispatcher ownership, and Codex compatibility. Network calls are stubbed. Set `PI_ROOT` if pi is installed somewhere other than `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`.

Optional real-session integration check (also offline):

```sh
PI_COMPACTION_STUB=1 node extensions/cache-compaction/tests/responses-cache-e2e.mjs
```

Live tests use configured credentials and make real requests that consume provider quota. Configured model-cost estimates are not OAuth subscription invoices. They use synthetic data, isolated sessions, and in-memory settings/model limits; shared `models.json` and `settings.json` are not changed:

```sh
PI_LIVE_COMPACTION=1 node extensions/cache-compaction/tests/live.mjs openai-codex gpt-5.6-luna
PI_LIVE_COMPACTION=1 node extensions/cache-compaction/tests/live.mjs openai gpt-6-astra
PI_LIVE_COMPACTION=1 node extensions/cache-compaction/tests/responses-cache-e2e.mjs gpt-6-astra
PI_LIVE_COMPACTION=1 node extensions/cache-compaction/tests/live.mjs deepseek deepseek-flash
```

## Attribution and license

The code under `codex/` is derived from **Can Celik** ([ogulcancelik](https://github.com/ogulcancelik))'s **[@ogulcancelik/pi-codex-compaction](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction)**, version **0.1.5**.

Copyright (c) 2025 Can Celik. The original MIT license is preserved in [`codex/LICENSE`](codex/LICENSE). Keep that notice and license with copies or substantial portions of the Codex code.

Local adaptations:

- Return the Codex compaction handler to the shared dispatcher instead of registering a separate extension entry point.
- Preserve fail-closed Codex errors without falling through to text compaction.
- Honor resolved authentication's base-URL override and bound the remote request to five minutes.
- Use plain-text status labels.

The native adapter also projects context edits during replay. The legacy timing/configuration adapter has been removed. There is no runtime dependency on the original npm package.
