# Codex native compaction

This extension provides remote opaque checkpoints for Codex. The `cache-compaction` directory name is retained so existing extension settings keep working.

| Model/provider | Compaction | Failure behavior |
| --- | --- | --- |
| `openai-codex` with `openai-codex-responses` | Codex remote opaque checkpoint | Cancel; preserve existing history |
| All other providers and API shapes | Pi native compaction | Unchanged |

The standard `openai` provider uses pi's native compaction. Upstream Codex compaction does not support its API-key Responses endpoint.

## Behavior

Pi owns manual, threshold, overflow, and between-turn compaction timing on pi 0.84.4 and later. The extension registers no tree-navigation or branch-summary handlers. Non-Codex compaction uses pi's native summarizer without an extension request.

The Codex path preserves upstream's opaque checkpoint format and replay rules, so sessions created by the npm extension remain readable. Its remote replacement history has its own recent-user-message retention policy, distinct from the text path's retained tail. It fails closed if a checkpoint is malformed or belongs to another Codex model. Switching providers cannot translate opaque history into text; only surviving pi messages remain available to other providers. Local Codex checkpoint markers are filtered from live context.

For older pi releases, the vendored Codex adapter retains upstream's legacy guard and `pi-codex-compaction.json` configuration. Modern pi uses its normal compaction settings instead.

## Loading and migration

Load only `extensions/cache-compaction/index.ts`. Do not also load `npm:@ogulcancelik/pi-codex-compaction`, or both copies will register hooks.

The npm source was removed from `settings.json` while its installed files were left untouched. Existing processes need `/reload` or a restart to stop using the removed cache-aligned text path. Previously saved text summaries remain usable by pi.

## Tests

From `~/.pi/agent`:

```sh
node extensions/cache-compaction/tests/combined.mjs
```

The suite stubs network calls. Set `PI_ROOT` if pi is installed somewhere other than `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`.

## Attribution and license

The code under `codex/` is derived from **Can Celik** ([ogulcancelik](https://github.com/ogulcancelik))'s **[@ogulcancelik/pi-codex-compaction](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction)**, version **0.1.5**.

Copyright (c) 2025 Can Celik. The original MIT license is preserved in [`codex/LICENSE`](codex/LICENSE). Keep that notice and license with copies or substantial portions of the Codex code.

Local adaptations:

- Return the Codex compaction handler to the shared dispatcher instead of registering a separate extension entry point.
- Preserve fail-closed Codex errors without falling through to text compaction.
- Honor resolved authentication's base-URL override and bound the remote request to five minutes.
- Use plain-text status labels.

`codex/native-compaction.ts` and `codex/config.ts` otherwise match the installed upstream v0.1.5 sources. There is no runtime dependency on the original npm package.
