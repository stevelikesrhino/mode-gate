import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodexCompaction } from "./codex/extension.ts";
import { findNativeCheckpoint, isOpenAICodexModel } from "./codex/native-compaction.ts";
import registerTextCompaction from "./text-compaction.ts";

/** One owner for compaction; branch summarization remains pi's responsibility. */
export default function cacheCompaction(pi: ExtensionAPI): void {
	// Keep old Codex checkpoints readable; new public Responses uses text mode.
	const compactCodex = registerCodexCompaction(pi);
	const compactText = registerTextCompaction(pi);
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
		if (ctx.model?.api === "openai-responses" && findNativeCheckpoint(ctx.sessionManager.getBranch()).status !== "none") {
			notifyOpaque(ctx);
			return { cancel: true };
		}
		if (isOpenAICodexModel(ctx.model)) {
			// Fail closed even if an unexpected adapter/UI error escapes.
			try {
				return await compactCodex(event, ctx);
			} catch {
				return { cancel: true };
			}
		}
		// Public Responses shares the existing cache-aligned text path.
		return compactText(event, ctx);
	});
}
