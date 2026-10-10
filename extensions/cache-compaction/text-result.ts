import type { CompactionResult, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

type Preparation = SessionBeforeCompactEvent["preparation"];
type Model = NonNullable<ExtensionContext["model"]>;

export interface Summary {
	text: string;
	usage?: Usage;
}

export interface CompactionBudget {
	contextWindow: number;
	reserveTokens: number;
	keepRecentTokens: number;
}

interface TextCompactionDetails {
	kind: "cache-aligned-compaction";
	version: 1;
	budget: CompactionBudget;
}

export function summaryOutputTokens(model: Model, settings: Preparation["settings"], thinkingTokens = 0): number {
	// Ignore the live request's potentially clamped output cap. Retaining more
	// history shortens the summary prefix and increases its output allowance.
	const summaryTokens = Math.max(8192, settings.keepRecentTokens, settings.reserveTokens);
	return Math.max(1, Math.min(summaryTokens + thinkingTokens, model.maxTokens > 0 ? model.maxTokens : Infinity));
}

export function createTextCompaction(preparation: Preparation, model: Model, summary: Summary): CompactionResult<TextCompactionDetails> {
	return {
		summary: summary.text,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		usage: summary.usage,
		details: {
			kind: "cache-aligned-compaction",
			version: 1,
			budget: {
				contextWindow: model.contextWindow,
				reserveTokens: preparation.settings.reserveTokens,
				keepRecentTokens: preparation.settings.keepRecentTokens,
			},
		},
	};
}

/** Persisted details are untrusted; old checkpoints may not have a budget. */
export function readCompactionBudget(details: unknown): CompactionBudget | undefined {
	if (!details || typeof details !== "object" || !("kind" in details) || details.kind !== "cache-aligned-compaction" || !("budget" in details)) return;
	const budget = details.budget;
	if (!budget || typeof budget !== "object") return;
	const { contextWindow, reserveTokens, keepRecentTokens } = budget as Partial<CompactionBudget>;
	const isTokenCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (!isTokenCount(contextWindow) || !isTokenCount(reserveTokens) || !isTokenCount(keepRecentTokens)) return;
	return { contextWindow, reserveTokens, keepRecentTokens };
}
