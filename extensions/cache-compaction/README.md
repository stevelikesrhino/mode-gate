# Cache compaction

One pi extension for two compaction paths:

| Model/provider | Compaction | Failure behavior |
| --- | --- | --- |
| `openai-codex` with `openai-codex-responses` | Codex remote opaque checkpoint | Cancel; preserve existing history |
| Other providers using `openai-completions` or `anthropic-messages` | Cache-aligned text summary | Return control to pi's native compaction |
| `openai`, unsupported APIs | Pi native compaction | Unchanged |

The standard `openai` provider is deliberately excluded from the text path. Upstream Codex compaction does not support its API-key Responses endpoint.

## Behavior

Requires pi 0.87.0 or later. Pi owns manual, threshold, overflow, and between-turn compaction timing. Neither path registers tree-navigation or branch-summary handlers.

The text path preserves pi's `firstKeptEntryId`, including `keepRecentTokens` and split-turn cut selection. It summarizes the history and turn prefix together in one request. Captured provider message content is reused without changing tool selection. If truncation removes an Anthropic conversation cache breakpoint, its TTL and cache policy move to the last eligible retained block. SDK-only beta/profile parameters are translated into HTTP headers; OAuth and Copilot credentials use bearer authentication. Unknown wire mappings or divergent history fall back to native compaction. Cache reads depend on the provider's serialization, cache availability, and breakpoints; they are not guaranteed for every supported API shape.

The Codex path preserves upstream's opaque checkpoint format and replay rules, so sessions created by the npm extension remain readable. Its remote replacement history has its own recent-user-message retention policy, distinct from the text path's retained tail. It fails closed if a checkpoint is malformed or belongs to another Codex model. Switching providers cannot translate opaque history into text; only surviving pi messages remain available to other providers. Local Codex checkpoint markers are filtered from live context.

Use Pi's normal compaction settings, including `compaction.modelOverrides`. Legacy `pi-codex-compaction.json` settings are no longer read.

Codex replay honors append-only context edits in the post-checkpoint tail. Edits targeting history already absorbed into an opaque checkpoint fail closed. Text compaction uses Pi's projected preparation; if a limit failure requires a new cut on a branch containing context edits, it yields to native compaction rather than reconstructing an edit-unaware boundary.

## Loading and migration

Load only `extensions/cache-compaction/index.ts`. Do not also load `npm:@ogulcancelik/pi-codex-compaction`, or both copies will register hooks.

The migration removes the npm source from `settings.json` while leaving its installed files untouched. Existing processes need `/reload` or a restart. The text path needs a subsequent live provider request to populate capture; compaction immediately after reload may use native fallback.

Set `CC_DEBUG_LOG=/path/to/log.jsonl` before startup to enable text-path diagnostics. Logging is off by default. Request bodies and authentication headers are not logged.

## Tests

From `~/.pi/agent`:

```sh
node extensions/cache-compaction/tests/text-compaction.mjs
node extensions/cache-compaction/tests/combined.mjs
```

Both suites stub network calls. Set `PI_ROOT` if pi is installed somewhere other than `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`.

Live tests use configured credentials and make billed requests. They use synthetic data, isolated sessions, and in-memory settings/model limits; shared `models.json` and `settings.json` are not changed:

```sh
PI_LIVE_COMPACTION=1 node extensions/cache-compaction/tests/live.mjs openai-codex gpt-5.6-luna
PI_LIVE_COMPACTION=1 node extensions/cache-compaction/tests/live.mjs openai gpt-5.6-luna
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
