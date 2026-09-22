import { getCurrentSystemMessage, getCurrentSystemPrompt, type Context, type Message, type Tool } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
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

Keep each section concise. Preserve exact file paths, function names, and error messages.

Do not call tools. Output only the structured summary.`;

const HANDOFF_WIDGET_KEY = "handoff-progress";

type SessionEntry = ReturnType<ExtensionCommandContext["sessionManager"]["getEntries"]>[number];

type HandoffEntry = SessionEntry & {
	type: "custom_message";
	customType: "handoff";
	id: string;
	parentId: string | null;
};

function showPendingHandoff(ctx: ExtensionCommandContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget(HANDOFF_WIDGET_KEY, [ctx.ui.theme.fg("muted", "Handoff pending...")]);
}

function showHandoffLoader(ctx: ExtensionCommandContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget(HANDOFF_WIDGET_KEY, (tui, theme) => {
		const loader = new Loader(
			tui,
			(frame) => theme.fg("accent", frame),
			(message) => theme.fg("muted", message),
			"Handing off...",
		);
		return {
			render: (width: number) => loader.render(width).slice(1),
			invalidate: () => loader.invalidate(),
			dispose: () => loader.stop(),
		};
	});
}

function clearHandoffStatus(ctx: ExtensionCommandContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget(HANDOFF_WIDGET_KEY, undefined);
}

function isHandoffEntry(entry: SessionEntry | undefined): entry is HandoffEntry {
	return entry?.type === "custom_message" && entry.customType === "handoff";
}

function activeToolDeclarations(pi: ExtensionAPI): Tool[] {
	const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	return pi.getActiveTools().flatMap((name) => {
		const tool = toolsByName.get(name);
		return tool ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }] : [];
	});
}

function buildHandoffContext(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	messages: Message[],
): Context {
	const effectivePrompt = ctx.getSystemPrompt();
	const hasSystemMessage = messages.some((message) => message.role === "system");

	// Sessions created before prompt checkpoints need the current prompt and tool
	// loadout declared once, just as they were before transcript-backed prompts.
	if (!hasSystemMessage) {
		return {
			systemPrompt: effectivePrompt,
			messages,
			tools: activeToolDeclarations(pi),
		};
	}

	if (effectivePrompt === getCurrentSystemPrompt(messages)) return { messages };

	// Match Pi's request-time prompt projection when the current effective prompt
	// differs from the last prompt recorded in the transcript.
	const current = getCurrentSystemMessage(messages);
	return {
		messages: [
			{
				role: "system",
				content: effectivePrompt,
				...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
				timestamp: current?.timestamp ?? Date.now(),
			},
			...messages.filter((message) => message.role !== "system"),
		],
	};
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
		description: "Write HANDOFF.md without changing the conversation",
		handler: async (_args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const wasIdle = ctx.isIdle();
			if (!wasIdle) showPendingHandoff(ctx);

			try {
				if (!wasIdle) await ctx.waitForIdle();
				showHandoffLoader(ctx);

				const model = ctx.model!;
				const agentMessages = ctx.sessionManager.buildSessionProjection().messages;
				if (!agentMessages.some((message) => message.role !== "system")) {
					ctx.ui.notify("No conversation to hand off", "warning");
					return;
				}

				const handoffInstruction: Message = {
					role: "user",
					content: [{ type: "text", text: COMPACTION_PROMPT }],
					timestamp: Date.now(),
				};
				const context = buildHandoffContext(pi, ctx, [
					...convertToLlm(agentMessages),
					handoffInstruction,
				]);
				const thinkingLevel = pi.getThinkingLevel();
				const response = await ctx.modelRegistry.streamSimple(
					model,
					context,
					{
						maxTokens: 8192,
						reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
						sessionId: ctx.sessionManager.getSessionId(),
					},
				).result();
				if (response.stopReason !== "stop") {
					throw new Error(
						response.errorMessage ?? `Handoff summarization did not finish: ${response.stopReason}`,
					);
				}
				if (response.content.some((part) => part.type === "toolCall")) {
					throw new Error("Handoff summarization attempted to call a tool");
				}

				const summary = response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n")
					.trim();
				if (!summary) throw new Error("Handoff summarization returned no text");

				const handoffPath = join(ctx.cwd, "HANDOFF.md");
				const tempPath = `${handoffPath}.handoff-${process.pid}-${Date.now()}.tmp`;
				await writeFile(tempPath, `${summary}\n`, "utf-8");
				await rename(tempPath, handoffPath);
				ctx.ui.notify("HANDOFF.md created", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not write HANDOFF.md: ${message}`, "error");
			} finally {
				clearHandoffStatus(ctx);
			}
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
