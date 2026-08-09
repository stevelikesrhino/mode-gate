import {
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const RESUME_MESSAGE = "Compaction interrupted the tool loop. Continue the original task.";

export default function forcedCompactExtension(pi: ExtensionAPI): void {
	let pendingCompaction = false;
	let settingsManager: SettingsManager | undefined;

	function getSettingsManager(ctx: ExtensionContext): SettingsManager {
		settingsManager ??= SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		});
		return settingsManager;
	}

	function resumeToolLoop(): void {
		pendingCompaction = false;
		pi.sendMessage(
			{
				customType: "forced-compact-resume",
				content: RESUME_MESSAGE,
				display: false,
			},
			{ triggerTurn: true },
		);
	}

	pi.on("before_provider_request", (event) => {
		if (typeof event.payload !== "object" || event.payload === null) {
			return;
		}

		const payload = { ...event.payload } as Record<string, unknown>;
		delete payload.max_tokens;
		delete payload.max_completion_tokens;
		delete payload.max_output_tokens;
		return payload;
	});

	pi.on("turn_end", async (event, ctx) => {
		const hitOutputLimit = event.message.role === "assistant" && event.message.stopReason === "length";
		if (
			pendingCompaction ||
			(event.toolResults.length === 0 && !hitOutputLimit) ||
			ctx.hasPendingMessages()
		) {
			return;
		}

		const manager = getSettingsManager(ctx);
		await manager.reload();
		const settings = manager.getCompactionSettings();
		if (!settings.enabled) {
			return;
		}

		if (!hitOutputLimit) {
			const usage = ctx.getContextUsage();
			if (usage?.tokens === null || usage?.tokens === undefined) {
				return;
			}

			if (usage.tokens <= usage.contextWindow - settings.reserveTokens) {
				return;
			}
		}

		pendingCompaction = true;
		ctx.abort();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!pendingCompaction) {
			return;
		}

		pi.sendMessage({
			customType: "forced-compact-boundary",
			content: ".",
			display: false,
		});

		ctx.compact({
			onComplete: resumeToolLoop,
			onError: resumeToolLoop,
		});
	});
}
