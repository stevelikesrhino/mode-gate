import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodexCompaction } from "./codex/extension.ts";
import { isOpenAICodexModel } from "./codex/native-compaction.ts";
import registerTextCompaction from "./text-compaction.ts";

/** One owner for compaction; branch summarization remains pi's responsibility. */
export default function cacheCompaction(pi: ExtensionAPI): void {
	// Register Codex first so its persisted local marker is removed before
	// text-mode context observation after a provider switch.
	const compactCodex = registerCodexCompaction(pi);
	const compactText = registerTextCompaction(pi);

	pi.on("session_before_compact", async (event, ctx) => {
		if (isOpenAICodexModel(ctx.model)) {
			// Fail closed even if an unexpected adapter/UI error escapes.
			try {
				return await compactCodex(event, ctx);
			} catch {
				return { cancel: true };
			}
		}
		// The text path excludes openai and unsupported Codex API shapes.
		return compactText(event, ctx);
	});
}
