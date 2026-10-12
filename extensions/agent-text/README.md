# Agent Text

Peer discovery and two-way messaging between Pi and Claude Code sessions on the same machine and Pi profile, across projects. Agents can initiate conversations and reply to each other.

Pi connects directly; each Claude session runs its own bundled MCP adapter, which reads the session's ID, title, and activity from Claude's session registry, and a Claude Code mod (`claude-mod/`) reports its model to the adapter over a private socket. No central daemon or running Pi session is required for Claude-to-Claude messaging.

## Install

Copy this folder, including `dist/`, into `~/.pi/agent/extensions/agent-text/`, then run `/reload` in Pi. No `npm install` needed.

For Claude Code:

1. Have Node.js 22+ and Claude Code 2.1.277+ on `PATH`.
2. Leave Claude running normally, not with `--bare`, so setup can verify its session registry.
3. In Pi, run `/agent-text hire-claude` and confirm the user-scope MCP registration and the mod entry (`env.CLAUDE_CODE_PLUGIN_DIRS` in Claude's `settings.json`). Rerun it to add the mod to an older install, to repair a registration whose Node.js path no longer exists, or to finish a partial install.
4. Restart Claude and check `/mcp` for `agent-text`.

## Commands

| Command | Where | Purpose |
| --- | --- | --- |
| `/agent-text` | Pi, Claude Code (mod) | Show online agents in a popup. |
| `/offline` | Pi | Disconnect this session; remembered across restarts. |
| `/online` | Pi | Reconnect this session. |
| `/agent-text hire-claude` | Pi | Check compatibility, then register Claude messaging and the mod. |
| `/agent-text fire-claude` | Pi | Remove the Claude registration and mod entry; restart Claude afterward. |

Agents use `list_agent` and `text_agent({ ids: ["agent-id"], text: "message" })`. In Claude, these are `mcp__agent-text__list_agent` and `mcp__agent-text__text_agent`, **not** native `ListAgent` or `SendMessage`. Disable the adapter through Claude's `/mcp` to disconnect it.

## Limitations

- Local, same-user communication only. One Claude registration targets one Pi profile.
- A Claude agent's ID is derived from the session its adapter started with and stays fixed for that adapter's lifetime, including across `/clear` and resume. It falls back to a random ID when that name is still taken: the same session open twice, or a socket file left by a crash. Pi IDs are random per session start, including `/reload`. A rejected stale ID means: list agents again.
- Claude session ID and idle/busy come from Claude's session registry; the model comes from the mod, and is used only while the mod's report matches the current session. Without the mod (not loaded, or before its first report) the model is the background-job alias from job state when available, and activity falls back to unknown when the registry has none. The mod API is early access; Claude updates may require a mod update.
- Claude session names come from Claude's session registry; sessions without a title use `Claude <directory> (<id>)`.
- Spare workers and parked launchers are hidden; live detached sessions remain visible.
- Filtering depends on Claude's internal session registry. Missing or incompatible owner records disable that adapter's messaging. This fails closed: a missing or non-1 `peerProtocol` disables messaging even when the Claude version passes the minimum, so Claude updates may require an adapter update.
- At most 20 recipients and 16 KiB per message. An accepted receipt does not guarantee model processing; never automatically retry an unknown delivery.
- Native Windows runtime behavior has not been verified.

## Development

- `npm run build` regenerates `dist/claude-mcp.mjs` after changing `claude-mcp.ts`, `claude-registry.ts`, `ipc.ts`, or `messaging.ts`. Running Claude adapters keep the old bundle until their session restarts.
- `npm test` runs the Pi, adapter, and setup tests, then `claude plugin test claude-mod`.
- Claude reloads `claude-mod/` in every running session when its files change; stage mod edits elsewhere and copy them in once validated. Pi also imports `claude-mod/hooks/table.ts` for its `/agent-text` popup, so changes there need `/reload` in Pi too. `claude-mod/tsconfig.json` extends types Claude generates after loading the mod once.
