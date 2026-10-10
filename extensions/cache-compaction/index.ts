import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodexCompaction } from "./codex/extension.ts";
import { findNativeCheckpoint, isOpenAICodexModel } from "./codex/native-compaction.ts";
import registerTextCompaction, { cancelCompaction } from "./text-compaction.ts";
import registerCompactionStats from "./stats.ts";

/** One owner for compaction; branch summarization remains pi's responsibility. */
export default function cacheCompaction(pi: ExtensionAPI): void {
	// Keep old Codex checkpoints readable; new public Responses uses text mode.
	const compactCodex = registerCodexCompaction(pi);
	const compactText = registerTextCompaction(pi);
	registerCompactionStats(pi);
	const opaqueError = "This branch contains an opaque Codex checkpoint. Use its original Codex model or return to the branch before compaction; it cannot be converted to a text summary.";
	const notifyOpaque = (ctx: ExtensionContext): void => {
		try {
			if (ctx.hasUI) ctx.ui.notify(opaqueError, "error");
		} catch {
			// UI errors must not turn a safety cancellation into native fallback.
		}
	};

	// An opaque checkpoint is not a plaintext summary. Do not silently lose it
	// after switching an existing Codex session to public Responses.
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.api !== "openai-responses" || findNativeCheckpoint(ctx.sessionManager.getBranch()).status === "none") return;
		ctx.abort();
		notifyOpaque(ctx);
		return { ...(event.payload as Record<string, unknown>), input: [] };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// An absent result or escaped error must never invoke Pi's summarizer.
		try {
			const codex = isOpenAICodexModel(ctx.model);
			if (!codex && findNativeCheckpoint(event.branchEntries).status !== "none") {
				notifyOpaque(ctx);
				return { cancel: true };
			}
			const result = await (codex ? compactCodex(event, ctx) : compactText(event, ctx));
			return result?.compaction ? result : { cancel: true };
		} catch (error) {
			return cancelCompaction(ctx, `unexpected compaction error: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
