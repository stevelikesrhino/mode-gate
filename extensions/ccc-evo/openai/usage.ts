import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fetchUsage, UsageError, type UsageSnapshot, type UsageWindow } from "./usage-api.ts";

const resetDate = new Intl.DateTimeFormat(undefined, {
	month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

function resetLabel(timestamp: number | undefined): string {
	if (timestamp === undefined) return "reset not reported";
	const minutes = Math.ceil((timestamp - Date.now()) / 60_000);
	if (minutes <= 0) return "reset due · r to refresh";
	const days = Math.floor(minutes / (24 * 60));
	const hours = Math.floor(minutes / 60) % 24;
	const remaining = days > 0 ? `${days}d ${hours}h`
		: hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
	return `resets ${resetDate.format(timestamp)} (in ${remaining})`;
}

// Requests belong to one panel and are cancelled when it closes.
class UsageState {
	snapshot?: UsageSnapshot;
	error?: UsageError;
	loading = false;
	private request?: AbortController;

	constructor(private readonly onChange: () => void) {}

	async refresh(ctx: ExtensionContext): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.error = undefined;
		const request = this.request = new AbortController();
		const timeout = setTimeout(() => request.abort(), 15_000);
		let onAbort = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(new UsageError("Usage request timed out. Press r to retry."));
			request.signal.addEventListener("abort", onAbort, { once: true });
		});
		this.onChange();
		try {
			// The race also bounds Pi's token refresh, whose API has no signal argument.
			const snapshot = await Promise.race([fetchUsage(ctx, request.signal), aborted]);
			if (this.request === request) this.snapshot = snapshot;
		} catch (error) {
			if (this.request === request) {
				this.error = error instanceof UsageError ? error
					: new UsageError("Could not load usage. Check your connection and press r.");
			}
		} finally {
			clearTimeout(timeout);
			request.signal.removeEventListener("abort", onAbort);
			// A cancelled request must not publish into a replacement session/request.
			if (this.request === request) {
				this.request = undefined;
				this.loading = false;
				this.onChange();
			}
		}
	}

	cancel(): void {
		this.request?.abort();
		this.request = undefined;
		this.loading = false;
	}
}

export class UsagePanel {
	private disposed = false;

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly state: UsageState,
	) {
		void this.state.refresh(ctx);
	}

	handleInput(data: string): boolean {
		const isShortcut = ["escape", "ctrl+c", "r"].some(key => matchesKey(data, key));
		if (!isShortcut) return false;
		// Raw terminal listeners receive Kitty releases/repeats before Pi filters them.
		if (isKeyRelease(data) || isKeyRepeat(data)) return true;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.close();
		else if (matchesKey(data, "r")) void this.state.refresh(this.ctx);
		return true;
	}

	close(): void {
		if (this.disposed) return;
		this.dispose();
		this.done();
	}

	dispose(): void {
		this.disposed = true;
		this.state.cancel();
	}

	invalidate(): void {}

	private windowLine(window: UsageWindow, width: number): string {
		const th = this.theme;
		const name = th.fg("text", window.label.padEnd(7));
		if (window.usedPercent === undefined) {
			return `${name}  ${th.fg("muted", "usage not reported")} · ${th.fg("dim", resetLabel(window.resetAt))}`;
		}
		const remaining = 100 - window.usedPercent;
		const color = remaining <= 10 ? "error" : remaining <= 25 ? "warning" : "success";
		const percent = th.fg(color, `${Math.round(remaining)}% left`.padStart(9));
		const filled = Math.round(remaining / 10);
		const bar = width >= 72 ? `${th.fg(color, "━".repeat(filled))}${th.fg("dim", "─".repeat(10 - filled))}  ` : "";
		return `${name}  ${bar}${percent} · ${th.fg("muted", resetLabel(window.resetAt))}`;
	}

	render(width: number): string[] {
		const th = this.theme;
		const boxWidth = Math.max(2, width - 2);
		const innerWidth = Math.max(1, boxWidth - 6);
		const { snapshot, loading, error } = this.state;
		const title = snapshot ? `Codex usage · ${snapshot.plan}` : "OpenAI usage";
		const status = loading ? "loading…" : snapshot
			? snapshot.blocked ? "limit reached" : `updated ${clock.format(snapshot.fetchedAt)}` : "";
		const keys = th.fg("dim", "r refresh · esc close");
		const heading = th.fg("accent", title) + (status ? `  ${th.fg(snapshot?.blocked ? "error" : "dim", status)}` : "");
		const titleWidth = Math.max(0, innerWidth - visibleWidth(keys) - 2);
		const left = truncateToWidth(heading, titleWidth, "…");
		const header = innerWidth >= visibleWidth(keys) + 10
			? left + " ".repeat(Math.max(2, innerWidth - visibleWidth(left) - visibleWidth(keys))) + keys
			: `${th.fg("accent", "Usage")}  ${keys}`;

		let rows: string[];
		if (loading) rows = [th.fg("muted", "Fetching subscription limits…")];
		else if (error) rows = [th.fg("warning", error.message), th.fg("dim", error.hint)];
		else if (snapshot) rows = snapshot.windows.length
			? snapshot.windows.map(window => this.windowLine(window, innerWidth))
			: [th.fg("muted", "No usage windows reported for this subscription.")];
		else rows = [];

		const border = (text: string) => th.fg("border", text);
		const wrappedRows = rows.flatMap(line => innerWidth >= 24
			? wrapTextWithAnsi(line, innerWidth) : [truncateToWidth(line, innerWidth, "…")]);
		const content = ["", header, "", ...wrappedRows, ""];
		const lines = [
			border(`╭${"─".repeat(boxWidth - 2)}╮`),
			...content.map(line => border("│") + "  " + truncateToWidth(line, innerWidth, "…", true) + "  " + border("│")),
			border(`╰${"─".repeat(boxWidth - 2)}╯`),
		];
		return lines.map(line => truncateToWidth(` ${th.bg("toolPendingBg", line)} `, width, ""));
	}
}

export function registerUsage(pi: ExtensionAPI): void {
	const widgetKey = "pi-openai:usage";
	let closeActive: (() => void) | undefined;
	pi.registerCommand("usage", {
		description: "Show OpenAI subscription limits and resets (r refresh, Esc close)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/usage requires the interactive terminal UI.", "info");
				return;
			}
			if (closeActive) return;
			// A below-editor widget participates in layout, shrinking the transcript
			// viewport instead of painting over the editor or the fast-mode footer.
			ctx.ui.setWidget(widgetKey, (tui, theme) => {
				const close = () => ctx.ui.setWidget(widgetKey, undefined);
				const state = new UsageState(() => tui.requestRender());
				const panel = new UsagePanel(ctx, theme, close, state);
				const unsubscribe = ctx.ui.onTerminalInput(data => {
					if (panel.handleInput(data)) return { consume: true };
					return undefined;
				});
				closeActive = close;
				return {
					render: (width: number) => panel.render(width),
					invalidate: () => panel.invalidate(),
					dispose() {
						unsubscribe();
						panel.dispose();
						closeActive = undefined;
					},
				};
			}, { placement: "belowEditor" });
		},
	});
	pi.on("session_start", () => closeActive?.());
	pi.on("session_shutdown", () => closeActive?.());
}
