import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const COMPACTION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

type SessionEntry = ReturnType<ExtensionCommandContext["sessionManager"]["getEntries"]>[number];

type HandoffEntry = SessionEntry & {
	type: "custom_message";
	customType: "handoff";
	id: string;
	parentId: string | null;
};

function sendUserMessage(pi: ExtensionAPI, ctx: { isIdle(): boolean }, message: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(message);
		return;
	}
	pi.sendUserMessage(message, { deliverAs: "followUp" });
}

function isHandoffEntry(entry: SessionEntry | undefined): entry is HandoffEntry {
	return entry?.type === "custom_message" && entry.customType === "handoff";
}

async function pruneOrphanHandoffLeaves(sessionFile: string, activeBranchIds: Set<string>): Promise<number> {
	let content: string;
	try {
		content = await readFile(sessionFile, "utf-8");
	} catch {
		return 0;
	}

	let entries = content
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as SessionEntry | { type: "session"; id: string });
	let removed = 0;

	while (true) {
		const parentIds = new Set(
			entries
				.map((entry) => "parentId" in entry ? entry.parentId : undefined)
				.filter((parentId): parentId is string => typeof parentId === "string"),
		);
		const removeIds = new Set(
			entries
				.filter((entry): entry is HandoffEntry => isHandoffEntry(entry as SessionEntry))
				.filter((entry) => !activeBranchIds.has(entry.id) && !parentIds.has(entry.id))
				.map((entry) => entry.id),
		);

		if (removeIds.size === 0) break;
		entries = entries.filter((entry) => !("id" in entry && removeIds.has(entry.id)));
		removed += removeIds.size;
	}

	if (removed > 0) {
		const tempFile = `${sessionFile}.handoff-prune-${process.pid}.tmp`;
		await writeFile(tempFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
		await rename(tempFile, sessionFile);
	}

	return removed;
}

export default function handoffExtension(pi: ExtensionAPI): void {
	pi.registerCommand("handoff", {
		description: "Write HANDOFF.md using pi's compaction prompt",
		handler: async (_args, ctx) => {
			const handoffPath = join(ctx.cwd, "HANDOFF.md");
			sendUserMessage(
				pi,
				ctx,
				`Write a handoff file at ${handoffPath} using the current conversation context. Do not check whether HANDOFF.md exists. Do not ask for permission to overwrite it. Just write or overwrite it. Use this exact compaction prompt as the instructions for the file content:

${COMPACTION_PROMPT}`,
			);
		},
	});

	pi.registerCommand("handin", {
		description: "Read HANDOFF.md into the current conversation",
		handler: async (_args, ctx) => {
			const handoffPath = join(ctx.cwd, "HANDOFF.md");
			let handoff: string;
			try {
				handoff = await readFile(handoffPath, "utf-8");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not read HANDOFF.md: ${message}`, "error");
				return;
			}

			const hasUserMessage = ctx.sessionManager
				.getEntries()
				.some((entry) => entry.type === "message" && entry.message.role === "user");
			if (!hasUserMessage) {
				const parentSession = ctx.sessionManager.getSessionFile();
				const result = await ctx.newSession({
					parentSession,
					withSession: async (nextCtx) => {
						await nextCtx.sendMessage({
							customType: "handoff",
							content: handoff,
							display: false,
						});
						setTimeout(() => {
							nextCtx.ui.notify("HANDOFF.md loaded into conversation", "info");
						}, 0);
					},
				});
				if (result.cancelled) {
					ctx.ui.notify("HANDOFF.md not loaded — new session cancelled", "warning");
				}
				return;
			}

			const leaf = ctx.sessionManager.getLeafEntry();
			if (isHandoffEntry(leaf)) {
				let firstHandoff = leaf;
				let parent = firstHandoff.parentId ? ctx.sessionManager.getEntry(firstHandoff.parentId) : undefined;
				while (isHandoffEntry(parent)) {
					firstHandoff = parent;
					parent = firstHandoff.parentId ? ctx.sessionManager.getEntry(firstHandoff.parentId) : undefined;
				}

				if (parent && !(parent.type === "message" && parent.message.role === "user")) {
					const result = await ctx.navigateTree(parent.id, { summarize: false });
					if (result.cancelled) {
						ctx.ui.notify("HANDOFF.md not loaded — navigation cancelled", "warning");
						return;
					}
				}
			}

			pi.sendMessage({
				customType: "handoff",
				content: handoff,
				display: false,
			});

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("HANDOFF.md loaded into conversation", "info");
				return;
			}

			const activeBranchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
			const pruned = await pruneOrphanHandoffLeaves(sessionFile, activeBranchIds);
			if (pruned === 0) {
				ctx.ui.notify("HANDOFF.md loaded into conversation", "info");
				return;
			}

			const result = await ctx.switchSession(sessionFile, {
				withSession: async (nextCtx) => {
					nextCtx.ui.notify(`HANDOFF.md loaded into conversation — pruned ${pruned} orphan handoff message${pruned === 1 ? "" : "s"}`, "info");
				},
			});
			if (result.cancelled) {
				ctx.ui.notify(`HANDOFF.md loaded — pruned ${pruned} orphan handoff message${pruned === 1 ? "" : "s"}; reopen session to refresh`, "warning");
			}
		},
	});
}
