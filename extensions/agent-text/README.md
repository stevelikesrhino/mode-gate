# Agent Text

Peer discovery and two-way messaging between Pi and Claude Code sessions on the same machine and Pi profile, across projects. Agents can initiate conversations and reply to each other.

Pi connects directly; each Claude session runs its own bundled MCP adapter, and a Claude Code mod (`claude-mod/`) pushes that session's ID, model, and activity to the adapter over a private Unix socket. No central daemon or running Pi session is required for Claude-to-Claude messaging.

## Install

Copy this folder, including `dist/`, into `~/.pi/agent/extensions/agent-text/`, then run `/reload` in Pi. No `npm install` needed.

For Claude Code:

1. Have Node.js 22+ and Claude Code 2.1.277+ on `PATH`.
2. Leave Claude running normally, not with `--bare`, so setup can verify its session registry.
3. In Pi, run `/agent-text setup-claude` and confirm the user-scope MCP registration and the mod entry (`env.CLAUDE_CODE_PLUGIN_DIRS` in Claude's `settings.json`). Rerun it to add the mod to an older install.
4. Restart Claude and check `/mcp` for `agent-text`.

## Commands

In Pi:

| Command | Purpose |
| --- | --- |
| `/agents` | Show discoverable agents. |
| `/agent-text` (in Claude Code) | Show discoverable agents; provided by the mod. |
| `/offline` | Disconnect this session; remembered across restarts. |
| `/online` | Reconnect this session. |
| `/agent-text setup-claude` | Check compatibility and register Claude messaging and the mod. |
| `/agent-text uninstall-claude` | Remove the Claude registration and mod entry; restart Claude afterward. |

Agents use `list_agent` and `text_agent({ ids: ["agent-id"], text: "message" })`. In Claude, these are `mcp__agent-text__list_agent` and `mcp__agent-text__text_agent`, **not** native `ListAgent` or `SendMessage`. Disable the adapter through Claude's `/mcp` to disconnect it.

## Limitations

- Local, same-user communication only. One Claude registration targets one Pi profile.
- A Claude agent's ID is derived from its session, so it survives Claude restarting the session's process. It falls back to a random ID when that name is still taken: the same session open twice, or a socket file left by a crash. Pi IDs are random per session start. A rejected stale ID means: list agents again.
- Claude session ID, model, and idle/busy come from the mod. Without it (mod not loaded, Windows, or before its first report) the session ID is random, activity is unknown, and the model is the background-job alias from job state when available. The mod API is early access; Claude updates may require a mod update.
- Claude session names come from Claude's session registry; sessions without a title use `Claude <directory> (<id>)`.
- Spare workers and parked launchers are hidden; live detached sessions remain visible.
- Filtering depends on Claude's internal session registry. Missing or incompatible owner records disable that adapter's messaging; Claude updates may require an adapter update.
- At most 20 recipients and 16 KiB per message. An accepted receipt does not guarantee model processing; never automatically retry an unknown delivery.
- Native Windows runtime behavior has not been verified.
