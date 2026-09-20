import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentInfo } from "./ipc.ts";

export async function showAgents(
	ctx: ExtensionCommandContext,
	self: string,
	load: (signal: AbortSignal) => Promise<AgentInfo[]>,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const controller = new AbortController();
		let agents: AgentInfo[] = [];
		let message = "Loading agents...";
		let refreshing = false;
		let closed = false;
		let offset = 0;
		let pageSize = 1;
		let maxOffset = 0;

		async function refresh(): Promise<void> {
			if (refreshing || closed) return;
			refreshing = true;
			tui.requestRender();
			try {
				agents = await load(controller.signal);
				message = agents.length ? "" : "No online agents.";
				offset = 0;
			} catch (error) {
				agents = [];
				message = error instanceof Error ? error.message : String(error);
			} finally {
				refreshing = false;
				if (!closed) tui.requestRender();
			}
		}

		void refresh();
		return {
			render(width) {
				const innerWidth = Math.max(1, width - 4);
				const content = agents.map((agent) => [
					theme.fg("accent", theme.bold(`${agent.name || "Unnamed session"}${agent.id === self ? " (you)" : ""}`))
						+ theme.fg("muted", ` — ${agent.kind ?? "pi"} · ${agent.status}`),
					theme.fg("dim", agent.id),
					`${agent.provider ?? "No provider"}/${agent.model ?? (agent.kind === "claude" ? "model unknown" : "No model")}`,
					theme.fg("muted", agent.cwd),
				].join("\n")).join("\n\n");
				const lines = new Text(content || message, 0, 0).render(innerWidth);
				pageSize = Math.max(1, Math.min(18, tui.terminal.rows - 8));
				maxOffset = Math.max(0, lines.length - pageSize);
				offset = Math.min(offset, maxOffset);
				const row = (text: string) => {
					const clipped = truncateToWidth(text, innerWidth);
					return theme.fg("border", "│ ") + clipped + " ".repeat(innerWidth - visibleWidth(clipped)) + theme.fg("border", " │");
				};
				const up = keybindings.getKeys("tui.select.up")[0] ?? "unbound";
				const down = keybindings.getKeys("tui.select.down")[0] ?? "unbound";
				const close = keybindings.getKeys("tui.select.cancel")[0] ?? "unbound";
				const position = maxOffset ? ` · ${offset + 1}–${Math.min(offset + pageSize, lines.length)}/${lines.length}` : "";
				return [
					theme.fg("border", "╭" + "─".repeat(Math.max(0, width - 2)) + "╮"),
					row(theme.fg("accent", `Online agents (${agents.length})`) + theme.fg("dim", refreshing ? " · refreshing..." : position)),
					row(""),
					...lines.slice(offset, offset + pageSize).map(row),
					row(""),
					row(theme.fg("dim", `${up}/${down} scroll · R refresh · ${close} close`)),
					theme.fg("border", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯"),
				].map((line) => truncateToWidth(line, width));
			},
			handleInput(data) {
				if (keybindings.matches(data, "tui.select.cancel")) {
					closed = true;
					controller.abort();
					done();
					return;
				}
				if (data === "r" || data === "R") { void refresh(); return; }
				if (keybindings.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
				else if (keybindings.matches(data, "tui.select.down")) offset = Math.min(maxOffset, offset + 1);
				else if (keybindings.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - pageSize);
				else if (keybindings.matches(data, "tui.select.pageDown")) offset = Math.min(maxOffset, offset + pageSize);
				tui.requestRender();
			},
			invalidate() {},
			dispose() { closed = true; controller.abort(); },
		};
	}, { overlay: true, overlayOptions: { width: "90%", margin: 1 } });
}
