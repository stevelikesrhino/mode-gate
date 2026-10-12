import { createHash, randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, keyHint, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { agentTable } from "./claude-mod/hooks/table.ts";
import { MAX_TEXT_BYTES, listen, privateDirectory, socketDirectory, type AgentInfo, type Response } from "./ipc.ts";
import { agentList, discoverAgents, GUIDELINES, LIST_DESCRIPTION, messageText, sendText, TEXT_DESCRIPTION, textMessage } from "./messaging.ts";
import { configureClaude } from "./setup-claude.ts";

// The same table as the Claude mod's /agent-text pane (claude-mod/hooks/table.ts).
async function showAgents(context: ExtensionCommandContext, agents: AgentInfo[], self: string): Promise<void> {
	const title = `Online agents (${agents.length})`;
	if (context.mode !== "tui") {
		context.ui.notify([title, ...agentTable(agents, self, homedir(), 100)].join("\n"), "info");
		return;
	}
	await context.ui.custom<void>((tui, theme, keybindings, done) => {
		let offset = 0;
		let maxOffset = 0;
		return {
			render(width) {
				const table = agentTable(agents, self, homedir(), width).map((line, index) =>
					index === 1 ? theme.fg("accent", line) : /^[\u256d\u251c\u2570]/.test(line) ? theme.fg("border", line) : line);
				const room = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 2);
				maxOffset = Math.max(0, table.length - room);
				offset = Math.min(offset, maxOffset);
				const hint = `${keybindings.getKeys("tui.select.cancel")[0] ?? "escape"} close${maxOffset ? " \u00b7 \u2191\u2193 scroll" : ""}`;
				return [theme.fg("accent", theme.bold(title)), ...table.slice(offset, offset + room), theme.fg("dim", hint)]
					.map((line) => truncateToWidth(line, width));
			},
			handleInput(data) {
				if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) return done();
				if (keybindings.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
				else if (keybindings.matches(data, "tui.select.down")) offset = Math.min(maxOffset, offset + 1);
				tui.requestRender();
			},
			invalidate() {},
		};
	}, { overlay: true, overlayOptions: { anchor: "bottom-left", width: "100%", maxHeight: "80%", margin: 0 } });
}

export default function agentText(pi: ExtensionAPI): void {
	const id = randomBytes(4).toString("hex");
	let ctx: ExtensionContext;
	let directory = "";
	let preference = "";
	let online = false;
	let running = false;
	let compacting = false;
	let startingUntil = 0;
	let stop: (() => Promise<void>) | undefined;
	let outgoing = new AbortController();

	function unavailable(): string | undefined {
		if (!online) return "Offline: use /online to reconnect.";
		if (!ctx.model) return "Unavailable: no model selected.";
		if (compacting || (!ctx.isIdle() && !running)) return "Unavailable: compacting or changing session; try again later.";
		if (Date.now() < startingUntil) return "Unavailable: starting a turn; try again later.";
	}

	function info(): AgentInfo {
		return {
			id,
			sessionId: ctx.sessionManager.getSessionId(),
			name: pi.getSessionName()?.slice(0, 120),
			cwd: ctx.cwd.slice(0, 300),
			provider: ctx.model?.provider.slice(0, 80),
			model: ctx.model?.id.slice(0, 120),
			status: unavailable() ? "unavailable" : ctx.isIdle() ? "idle" : "busy",
			kind: "pi",
		};
	}

	async function discover(signal?: AbortSignal): Promise<AgentInfo[]> {
		if (!online) throw new Error("Agent messaging is offline. Ask the user to run /online.");
		const combined = AbortSignal.any([outgoing.signal, ...(signal ? [signal] : [])]);
		return discoverAgents(directory, id, combined);
	}

	function receive(value: unknown): Response {
		if (!online) return { status: "rejected", reason: "Offline: this agent is disconnected." };
		if (!value || typeof value !== "object") return { status: "rejected", reason: "Invalid request." };
		if ((value as { kind?: unknown }).kind === "info") return { status: "ok", agent: info() };
		const message = textMessage(value);
		if (!message) {
			return { status: "rejected", reason: "Invalid message; text must be nonempty and at most 16 KiB." };
		}
		if (message.from.id === id) return { status: "rejected", reason: "Cannot text yourself." };
		const reason = unavailable();
		if (reason) return { status: "rejected", reason };
		const text = messageText(message);
		if (ctx.isIdle()) startingUntil = Date.now() + 5000;
		pi.sendUserMessage(text, { deliverAs: "steer", expandPromptTemplates: false });
		return { status: "accepted", reason: "Accepted for user-message delivery, not confirmation of model processing." };
	}

	function updateStatus(): void {
		if (ctx.hasUI) ctx.ui.setStatus("agent-text", online ? undefined : "agent text: offline");
	}

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		if (stop) return;
		running = false;
		compacting = false;
		startingUntil = 0;
		outgoing = new AbortController();
		const agentDir = await realpath(getAgentDir());
		directory = socketDirectory(agentDir);
		const preferences = join(agentDir, "agent-text", "offline");
		await privateDirectory(preferences);
		await privateDirectory(directory);
		preference = join(preferences, createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex"));
		stop = await listen(join(directory, `${id}.sock`), receive);
		online = !existsSync(preference);
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		online = false;
		outgoing.abort();
		const close = stop;
		stop = undefined;
		await close?.();
	});
	pi.on("agent_start", () => { running = true; startingUntil = 0; });
	pi.on("agent_settled", () => { running = false; startingUntil = 0; });
	pi.on("session_before_compact", () => { compacting = true; });
	pi.on("session_compact", () => { compacting = false; });
	pi.on("session_compact_failed", () => { compacting = false; });

	pi.registerCommand("offline", {
		description: "Disconnect this session from agent messaging (remembered across restarts)",
		handler: async (_args, context) => {
			if (!stop) throw new Error("Agent messaging did not start.");
			writeFileSync(preference, "", { mode: 0o600 });
			online = false;
			outgoing.abort();
			updateStatus();
			context.ui.notify("Agent messaging offline. Already accepted messages are not cancelled.", "info");
		},
	});
	pi.registerCommand("online", {
		description: "Reconnect this session to agent messaging",
		handler: async (_args, context) => {
			if (!stop) throw new Error("Agent messaging did not start.");
			try {
				unlinkSync(preference);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (!online) outgoing = new AbortController();
			online = true;
			updateStatus();
			context.ui.notify("Agent messaging online.", "info");
		},
	});

	pi.registerCommand("agent-text", {
		description: "Show online agents; hire-claude | fire-claude to add or remove Claude Code messaging",
		handler: async (args, context) => {
			const action = args.trim();
			if (action) return configureClaude(pi, action, context);
			if (!context.hasUI) {
				context.ui.notify("/agent-text needs an interactive session.", "warning");
				return;
			}
			if (!online) {
				context.ui.notify("Agent messaging is offline. Run /online first.", "warning");
				return;
			}
			await showAgents(context, [info(), ...await discover()], id);
		},
	});

	pi.registerTool({
		name: "list_agent",
		label: "list agents",
		description: LIST_DESCRIPTION,
		promptSnippet: "Discover running Pi and Claude Code agents for messaging",
		parameters: Type.Object({}),
		async execute(_callId, _params, signal) {
			const agents = await discover(signal);
			const result = agentList(id, agents);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "text_agent",
		label: "text agents",
		description: TEXT_DESCRIPTION,
		promptSnippet: "Send text to other running Pi and Claude Code agents",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			ids: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 20 }),
			text: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
		}),
		async execute(_callId, params, signal) {
			if (!online) throw new Error("Agent messaging is offline. Ask the user to run /online.");
			const combined = AbortSignal.any([outgoing.signal, ...(signal ? [signal] : [])]);
			const from = { id, name: pi.getSessionName()?.slice(0, 120) };
			const results = await sendText(directory, from, params.ids, params.text, combined);
			return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }], details: { results } };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const recipients = (args.ids ?? []).join(", ");
			const message = args.text ?? "";
			const preview = context.expanded ? message : message.split("\n").slice(0, 8).join("\n").slice(0, 1200);
			let content = theme.fg("toolTitle", theme.bold("text_agent")) + " " + theme.fg("accent", recipients);
			if (message) content += `\n\n${preview}`;
			if (preview !== message) content += "\n" + theme.fg("dim", `... (${keyHint("app.tools.expand", "to show full message")})`);
			text.setText(content);
			return text;
		},
	});
}
