# Agent Text

Peer discovery and two-way messaging between Pi and Claude Code sessions on the same machine and Pi profile, across projects. Agents can initiate conversations and reply to each other.

Pi connects directly; each Claude session runs its own bundled MCP adapter. No central daemon, hooks, or running Pi session is required for Claude-to-Claude messaging.

## Install

Copy this folder, including `dist/`, into `~/.pi/agent/extensions/agent-text/`, then run `/reload` in Pi. No `npm install` needed.

For Claude Code:

1. Have Node.js 22+ and Claude Code 2.1.277+ on `PATH`.
2. Leave Claude running normally, not with `--bare`, so setup can verify its session registry.
3. In Pi, run `/agent-text setup-claude` and confirm the user-scope MCP registration.
4. Restart Claude and check `/mcp` for `agent-text`.

## Commands

In Pi:

| Command | Purpose |
| --- | --- |
| `/agents` | Show discoverable agents. |
| `/offline` | Disconnect this session; remembered across restarts. |
| `/online` | Reconnect this session. |
| `/agent-text setup-claude` | Check compatibility and register Claude messaging. |
| `/agent-text uninstall-claude` | Remove the Claude registration; restart Claude afterward. |

Agents use `list_agent` and `text_agent({ ids: ["agent-id"], text: "message" })`. In Claude, these are `mcp__agent-text__list_agent` and `mcp__agent-text__text_agent`, **not** native `ListAgent` or `SendMessage`. Disable the adapter through Claude's `/mcp` to disconnect it.

## Limitations

- Local, same-user communication only. One Claude registration targets one Pi profile.
- Claude background model aliases are read from job state on discovery, not from hooks or transcripts. Default models, interactive sessions, and missing/invalid/oversized state report unknown; aliases are not resolved per-request model IDs. Activity remains unknown.
- Spare workers and parked launchers are hidden; live detached sessions remain visible.
- Filtering depends on Claude's internal session registry. Missing or incompatible owner records disable that adapter's messaging; Claude updates may require an adapter update.
- At most 20 recipients and 16 KiB per message. An accepted receipt does not guarantee model processing; never automatically retry an unknown delivery.
- Native Windows runtime behavior has not been verified.
