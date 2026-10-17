import {
	FooterComponent,
	type AgentSession,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { rgbColor, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const FAST_RED = rgbColor(255, 0, 0);

/** Delegate layout and stats to Pi; only color the model/thinking label. */
export function installFastFooter(
	ctx: ExtensionContext,
	autoCompactEnabled: () => boolean,
	fastActive: () => boolean,
): () => void {
	let requestRender = () => {};

	ctx.ui.setFooter((tui, theme, footerData) => {
		requestRender = () => tui.requestRender();
		// Pi exposes the renderer, but not its live AgentSession through ctx.ui.
		// Keep this adapter isolated: new native footer dependencies may require updates.
		// Live getters prevent model/thinking changes from freezing at installation time.
		const sessionView = {
			get state() {
				return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
			},
			get model() { return ctx.model; },
			sessionManager: ctx.sessionManager,
			getContextUsage: () => ctx.getContextUsage(),
			modelRuntime: {
				isUsingSubscription: (provider: string) => Boolean(
					ctx.model && ctx.modelRegistry.isUsingOAuth(ctx.model) &&
					ctx.modelRegistry.getProvider(provider)?.auth?.oauth?.isSubscription,
				),
			},
		};
		const inner = new FooterComponent(sessionView as unknown as AgentSession, footerData);
		const unsubscribe = footerData.onBranchChange(requestRender);

		return {
			dispose() {
				unsubscribe();
				inner.dispose();
				requestRender = () => {};
			},
			invalidate() { inner.invalidate(); },
			render(width: number): string[] {
				inner.setAutoCompactEnabled(autoCompactEnabled());
				const lines = inner.render(width);
				// Use the same live gate as priority injection, including during model changes.
				if (!fastActive() || !lines[1] || !ctx.model) return lines;

				const plain = stripTerminalSequences(lines[1]);
				// Pi separates stats from the right-aligned model with at least two spaces.
				const label = / {2,}(\S.*)$/.exec(plain)?.[1];
				if (!label) return lines;

				const level = ctx.thinkingLevel ?? "off";
				const modelLabel = ctx.model.id + (ctx.model.reasoning
					? ` • ${level === "off" ? "thinking off" : level}` : "");
				const providerLabel = `(${ctx.model.provider}) ${modelLabel}`;
				// Also color truncated model labels, but never the stats themselves.
				if (providerLabel.startsWith(label) || modelLabel.startsWith(label)) {
					const prefixWidth = visibleWidth(plain.slice(0, plain.length - label.length));
					const prefix = sliceByColumn(lines[1], 0, prefixWidth);
					// End the default footer's dim styling before applying red.
					lines[1] = prefix + "\x1b[0m" + theme.style(label, { fg: FAST_RED });
				}
				return lines;
			},
		};
	});
	return () => requestRender();
}
