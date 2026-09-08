import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodexCompaction } from "./codex/extension.ts";
import { isOpenAICodexModel } from "./codex/native-compaction.ts";

/** Codex remote compaction; all other summarization remains pi's responsibility. */
export default function cacheCompaction(pi: ExtensionAPI): void {
	const compactCodex = registerCodexCompaction(pi);

	pi.on("session_before_compact", async (event, ctx) => {
		if (isOpenAICodexModel(ctx.model)) {
			// Fail closed even if an unexpected adapter/UI error escapes.
			try {
				return await compactCodex(event, ctx);
			} catch {
				return { cancel: true };
			}
		}
		return undefined;
	});
}
