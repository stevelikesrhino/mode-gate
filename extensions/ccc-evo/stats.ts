import { estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { readCompactionBudget, type CompactionBudget } from "./text-result.ts";

const STATS_KIND = "cache-compaction-stats";

type CompactionStats = CompactionBudget & {
	tokensBefore: number;
	estimatedTokensAfter: number;
	usage?: Usage;
};

export default function registerCompactionStats(pi: ExtensionAPI): void {
	const timers = new Set<ReturnType<typeof setTimeout>>();

	pi.registerEntryRenderer<CompactionStats>(STATS_KIND, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const format = (tokens: number) => tokens.toLocaleString();
		const inputBudget = Math.max(0, data.contextWindow - data.reserveTokens);
		const utilization = inputBudget > 0 ? ` — ${(data.tokensBefore / inputBudget * 100).toFixed(1)}% used before compaction` : "";
		const lines = [
			`Input budget: ${format(inputBudget)} / ${format(data.contextWindow)}${utilization}`,
			`Output reserve: ${format(data.reserveTokens)} · retention target: ${format(data.keepRecentTokens)}`,
			`Post-compaction context: ~${format(data.estimatedTokensAfter)} tokens`,
		];
		if (data.usage) {
			const usage = data.usage;
			const input = usage.input + usage.cacheRead + usage.cacheWrite;
			const hitRate = input > 0 ? ` (${(usage.cacheRead / input * 100).toFixed(1)}%)` : "";
			lines.push(`Summary: ${format(input)} input · ${format(usage.cacheRead)} cached${hitRate} · ${format(usage.output)} output`);
			if (usage.cost.total > 0) lines.push(`Estimated summary cost: $${usage.cost.total.toFixed(6)}`);
		}
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("customMessageLabel", "[compaction stats]") + "\n\n" +
			lines.map((line) => theme.fg("customMessageText", line)).join("\n"), 0, 0));
		return box;
	});

	pi.on("session_compact", (event, ctx) => {
		if (ctx.mode !== "tui" || !event.fromExtension) return;
		const compaction = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
		if (!compaction || compaction.type !== "compaction") return;
		const budget = readCompactionBudget(compaction.details);
		if (!budget) return;
		const data: CompactionStats = { ...budget, tokensBefore: compaction.tokensBefore,
			estimatedTokensAfter: ctx.sessionManager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0),
			usage: compaction.usage };
		const sessionId = ctx.sessionManager.getSessionId();
		// Pi rebuilds the transcript after session_compact, placing its native card
		// last. Append on the next tick so this card appears beneath it, not above.
		const timer = setTimeout(() => {
			timers.delete(timer);
			try {
				if (ctx.sessionManager.getSessionId() !== sessionId ||
					ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.id !== compaction.id) return;
				pi.appendEntry(STATS_KIND, data);
			} catch {
				// Display-only telemetry must not affect compaction or continuation.
			}
		}, 0);
		timers.add(timer);
	});

	pi.on("session_shutdown", () => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	});
}
