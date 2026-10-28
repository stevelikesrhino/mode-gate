import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodexCompaction } from "./codex/extension.ts";
import { findNativeCheckpoint, isOpenAICodexModel } from "./codex/native-compaction.ts";
import registerTextCompaction, { warnCompaction } from "./text-compaction.ts";
import registerCompactionStats from "./stats.ts";
import registerFastMode from "./fast.ts";
import { createFastMode } from "./request-policy.ts";

/** Dispatch Codex and text compaction; leave branch summaries to Pi. */
export default function cccEvo(pi: ExtensionAPI): void {
	const fastMode = createFastMode();
	const compactCodex = registerCodexCompaction(pi, fastMode.prepareRequest);
	const compactText = registerTextCompaction(pi, fastMode.prepareRequest);
	registerCompactionStats(pi);
	const opaqueError = "This branch contains an opaque Codex checkpoint. Use its original Codex model or return to the branch before compaction; it cannot be converted to a text summary.";
	const notifyOpaque = (ctx: ExtensionContext): void => {
		try {
			if (ctx.hasUI) ctx.ui.notify(opaqueError, "error");
		} catch {
			// UI errors must not turn a safety cancellation into native fallback.
		}
	};

	// Public Responses cannot replay an opaque Codex checkpoint.
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.api !== "openai-responses" || findNativeCheckpoint(ctx.sessionManager.getBranch()).status === "none") return;
		ctx.abort();
		notifyOpaque(ctx);
		return { ...(event.payload as Record<string, unknown>), input: [] };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Unsupported text APIs may yield to Pi; failures in our paths must not.
		let signal: AbortSignal | undefined;
		try {
			signal = event.signal;
			if (signal.aborted || !ctx.model) return { cancel: true };
			const codex = isOpenAICodexModel(ctx.model);
			if (!codex && findNativeCheckpoint(event.branchEntries).status !== "none") {
				notifyOpaque(ctx);
				return { cancel: true };
			}
			if (codex) return await compactCodex(event, ctx) ?? { cancel: true };
			return await compactText(event, ctx);
		} catch (error) {
			if (signal?.aborted) return { cancel: true };
			const reason = error instanceof Error ? error.message : String(error);
			warnCompaction(ctx, `Compaction cancelled: ${reason}`);
			return { cancel: true };
		}
	});

	// Apply Fast after payload hooks so captures do not retain our priority override.
	registerFastMode(pi, fastMode);
}
