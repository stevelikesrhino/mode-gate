/**
 * Hashline Edit Extension — Overrides built-in `read` and `edit` with hash-anchored editing.
 *
 * Each line is identified by `LINE#HASH` where HASH is a 2-char staleness check derived
 * from the line content. The line number is the address; the hash detects stale references.
 * If the file changed since last read, hash mismatches are caught before any mutation.
 *
 * Motivation: LLM tokenizers insert phantom spaces at CJK↔ASCII boundaries, causing
 * text-matching edits to target wrong lines. Hashline editing sidesteps this entirely —
 * the model references line anchors, never reproduces original text.
 *
 * Overrides: `read` (hashline-formatted output) and `edit` (anchor-based operations).
 */

import {
	type ExtensionAPI,
	withFileMutationQueue,
	renderDiff,
	keyHint,
	createReadToolDefinition,
	defineTool,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text, Container } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access, readFile, writeFile } from "fs/promises";
import { resolve } from "path";

import {
	formatLineTag,
	parseRawEdits,
	applyHashlineEdits,
	generateEditDiff,
	detectLineEnding,
	normalizeLineEndings,
	parseDocument,
	restoreLineEndings,
	truncateContent,
} from "./utils";

const DEFAULT_GREP = "grep";
const FULL_READ_THRESHOLD = 3;
const COLLAPSED_DISPLAY_LINES = 10;

// ═══════════════════════════════════════════════════════════════════════════
// Edit preview computation (for renderCall)
// ═══════════════════════════════════════════════════════════════════════════

type EditPreviewResult = { diff: string; firstChangedLine?: number } | { error: string };

type EditRenderState = {
	argsKey?: string;
	preview?: EditPreviewResult;
};

async function computeEditPreview(
	path: string,
	edits: Array<{ op: string; pos?: string; end?: string; content: string }>,
	cwd: string,
): Promise<EditPreviewResult> {
	try {
		const absolutePath = resolve(cwd, path);

		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			return { error: `File not found: ${path}` };
		}

		const rawContent = await readFile(absolutePath, "utf-8");
		const hasBom = rawContent.startsWith("\uFEFF");
		const content = hasBom ? rawContent.slice(1) : rawContent;
		const normalized = normalizeLineEndings(content);

		const parsedEdits = parseRawEdits(edits, path);

		// Apply edits to get preview (validates hashes, generates diff)
		const { result: newNormalized, firstChangedLine } = applyHashlineEdits(normalized, parsedEdits);

		if (normalized === newNormalized) {
			return { error: `No changes would be made. The edits produce identical content.` };
		}

		// Generate diff
		const { diff } = generateEditDiff(normalized, parsedEdits, newNormalized);

		return { diff, firstChangedLine };
	} catch (err: any) {
		return { error: err?.message ?? String(err) };
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(
		Type.Object({
			op: StringEnum(
				["replace", "insert_after", "insert_before"],
				{
					description:
						"replace: Replace lines from pos to end (inclusive). Use the same anchor for pos and end to replace a single line. Use empty content to delete the range. " +
						"insert_after: Insert new lines immediately after the line at pos. " +
						"insert_before: Insert new lines immediately before the line at pos.",
				},
			),
			pos: Type.String({
				description: 'Line anchor "LINE#HASH" from read output (e.g. "5#PM"). Identifies which line to act on.',
			}),
			end: Type.String({
				description: 'End anchor "LINE#HASH" for replace (inclusive).',
			}),
			content: Type.String({
				description: "Replacement or insertion text. Use newlines for multiple lines. A trailing newline is preserved as a blank final line. Empty replacement deletes; empty insertion adds a blank line.",
			}),
		}),
	),
});

function normalizeEditArguments(input: unknown): unknown {
	if (!input) return input;

	let args: any = input;

	// Some providers/models emit tool arguments as a JSON string.
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			return input;
		}
	}

	if (typeof args !== "object" || Array.isArray(args)) {
		return args;
	}

	// Gemma/llama.cpp can emit edits as a JSON-encoded string.
	if (typeof args.edits === "string") {
		try {
			args = { ...args, edits: JSON.parse(args.edits) };
		} catch {
			// Keep original args so validator emits a clear error.
		}
	}

	return args;
}

const getSystemReadTool = (cwd?: string) => createReadToolDefinition(cwd ?? process.cwd());
const systemReadTool = getSystemReadTool();

export default function (pi: ExtensionAPI) {
	const fullReadCountsByFile = new Map<string, number>();
	const grepNudgeToolCallIds = new Set<string>();

	// ─── Add read_image (delegate to system read) ─────────────────────────
	const readImageTool = defineTool({
		name: "read_image",
		label: "read_image",
		description: systemReadTool.description,
		promptSnippet: "Read file contents with system read (use for images)",
		promptGuidelines: ["Use read_image for image files to preserve default image attachment behavior."],
		parameters: systemReadTool.parameters,
		async execute(
			toolCallId,
			params,
			signal?: AbortSignal,
			onUpdate?,
			ctx?,
		) {
			const delegate = getSystemReadTool(ctx?.cwd);
			return delegate.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall: systemReadTool.renderCall,
		renderResult: systemReadTool.renderResult,
	});

	// ─── Override read ───────────────────────────────────────────────────
	const readTool = defineTool({
		name: "read",
		label: "read",
		description:
			"Read file contents with hashline anchors. Each line is prefixed with LINE#HASH: " +
			"where LINE is the 1-indexed line number and HASH is a 2-char content hash. " +
			"Use these LINE#HASH anchors when calling the edit tool.",
		promptSnippet: "Read file with LINE#HASH anchors for editing",
		promptGuidelines: [
			"Use read to view files. Output format: LINE#HASH:content (e.g. 5#PM:hello).",
			"The LINE#HASH anchors are used by the edit tool to identify lines.",
			"Use offset/limit for large files. Continue with offset until complete.",
			"If you use glob/find/grep etc. to locate a certain part of the file, try to read around that part using offset and limit.",
		],
		parameters: readSchema,

			async execute(
					toolCallId,
					params,
					signal?: AbortSignal,
					_onUpdate?,
					ctx?,
				) {
			const { path, offset, limit } = params;
			const absolutePath = resolve(ctx?.cwd ?? process.cwd(), path);

				if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
					throw new Error(`offset must be an integer >= 1, got ${offset}`);
				}
				if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
					throw new Error(`limit must be an integer >= 1, got ${limit}`);
				}

			if (signal?.aborted) throw new Error("Operation aborted");

			try {
				await access(absolutePath, constants.R_OK);
			} catch {
				throw new Error(`File not found: ${path}`);
			}

			const raw = await readFile(absolutePath, "utf-8");
			const content = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
			const normalized = normalizeLineEndings(content);
			const allLines = parseDocument(normalized).lines;
			const totalLines = allLines.length;

			const startLine = offset !== undefined ? offset - 1 : 0;
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines)`);
			}

			let selectedLines: string[];
			let userLimited = false;
			if (limit !== undefined) {
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedLines = allLines.slice(startLine, endLine);
				userLimited = endLine < allLines.length;
			} else {
				selectedLines = allLines.slice(startLine);
			}

			// Format with hashline anchors
			const startLineNum = startLine + 1;
			const hashFormatted = selectedLines
				.map((line, i) => {
					const num = startLineNum + i;
					return `${formatLineTag(num, line)}:${line}`;
				})
				.join("\n");

				// Truncate if needed
					const { content: truncContent, truncated, shownLines } = truncateContent(hashFormatted);
					if (truncated) {
						const fullReadCount = (fullReadCountsByFile.get(absolutePath) ?? 0) + 1;
						fullReadCountsByFile.set(absolutePath, fullReadCount);
						if (fullReadCount >= FULL_READ_THRESHOLD) {
							grepNudgeToolCallIds.add(toolCallId);
						}
					}

				let truncationNotice: string | undefined;
				if (truncated) {
					const endShown = startLineNum + shownLines - 1;
					truncationNotice = `[Showing lines ${startLineNum}-${endShown} of ${totalLines}. Use offset=${endShown + 1} to continue.]`;
			} else if (userLimited) {
				const endShown = startLineNum + selectedLines.length - 1;
				const remaining = totalLines - (startLine + selectedLines.length);
				truncationNotice = `[${remaining} more lines. Use offset=${endShown + 1} to continue.]`;
			}

					const outputParts = [truncContent];
					if (truncationNotice) outputParts.push(truncationNotice);
					const outputText = outputParts.join("\n\n");

						return {
							content: [{ type: "text", text: outputText }],
							details: { lines: totalLines, truncationNotice },
						};
					},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const rawContent = result.content[0]?.text ?? "";

			// Strip LINE#HASH: prefixes for display
			const lines = rawContent.split("\n");
			const contentLines = lines
				.map((line) => {
					const match = line.match(/^\d+#[ZPMQVRWSNKTXJBYH]{2}:(.*)$/);
					return match ? match[1] : null;
				})
				.filter((line): line is string => line !== null);

			// Truncate for display when collapsed
		const maxLines = options.expanded ? contentLines.length : COLLAPSED_DISPLAY_LINES;
			const displayLines = contentLines.slice(0, maxLines);

			let output = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");

			if (!options.expanded && contentLines.length > maxLines) {
				output += `\n${theme.fg("muted", `... (${contentLines.length - maxLines} more lines)`)} ${keyHint("app.tools.expand", "to expand")}`;
			}

				// Show truncation notice from details
				const truncationNotice = result.details?.truncationNotice;
				if (truncationNotice) {
					output += `\n${theme.fg("warning", truncationNotice)}`;
				}
				text.setText(output);
				return text;
			},
		});

		pi.on("tool_result", async (event) => {
			if (event.toolName !== "read") return;
			if (!grepNudgeToolCallIds.has(event.toolCallId)) return;
			grepNudgeToolCallIds.delete(event.toolCallId);

			pi.sendMessage({
				customType: "line-edit",
				content: `Use [${DEFAULT_GREP}] to narrow range before the next read.`,
				display: true,
			}, {
				deliverAs: "steer",
			});
		});

		pi.on("tool_call", async (event) => {
			if (event.toolName === "read") return;
			fullReadCountsByFile.clear();
			grepNudgeToolCallIds.clear();
		});

	// ─── Override edit ───────────────────────────────────────────────────
	const editTool = defineTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a file using LINE#HASH anchors from read output. Supports multiple operations per call. " +
			"Hashes are validated before any changes — stale references are rejected with updated anchors.",
		promptSnippet: "Edit file using LINE#HASH anchors (replace, insert_after, insert_before)",
		renderShell: "default",
			promptGuidelines: [
				"Always read a file before editing it to get current LINE#HASH anchors.",
				"Read as many lines as you need before a large edit. Do NOT assume context from the lines that you didn't read.",
				"Tool arguments must be a top-level object with path and edits. Put path at the top level, never inside edits[].",
				"Reference lines by their anchor from read output (e.g. pos: \"6#PM\").",
				"Operations: replace (pos to end inclusive), insert_after, insert_before.",
				"When using replace for single-line replacements, you MUST set pos to end to the same line anchor.",
				"content is the replacement/insertion text. Use \\n for multiple lines. A trailing \\n is preserved as a blank final line. Empty replacement deletes lines; empty insertion adds a blank line.",
				"Never include LINE#HASH: prefixes in content. content must contain plain file text only.",
				"When editing code, prefer structurally complete edits. Do not replace only part of a function, class, loop, conditional, or try/catch block if that would leave duplicated, missing, or unbalanced lines.",
				"Before submitting an edit, check that the result will not duplicate adjacent lines or drop required lines such as braces, return statements, or closing delimiters.",
				"Example single-line replace: {\"path\":\"src/app.ts\",\"edits\":[{\"op\":\"replace\",\"pos\":\"6#PM\",\"end\":\"6#PM\",\"content\":\"const answer = 42;\"}]}",
				"Example multi-line replace: {\"path\":\"src/app.ts\",\"edits\":[{\"op\":\"replace\",\"pos\":\"5#PM\",\"end\":\"9#NQ\",\"content\":\"if (ok) {\\n  return value;\\n}\"}]}",
				"Example insert_after: {\"path\":\"src/app.ts\",\"edits\":[{\"op\":\"insert_after\",\"pos\":\"12#VR\",\"content\":\"console.log(answer);\"}]}",
				"Example insert_before: {\"path\":\"src/app.ts\",\"edits\":[{\"op\":\"insert_before\",\"pos\":\"3#WS\",\"content\":\"import { foo } from \\\"./foo\\\";\"}]}",
				"If hashes don't match (file changed), you'll get updated anchors — retry with those.",
			],
		parameters: editSchema,
		prepareArguments: normalizeEditArguments,

		async execute(
			_toolCallId,
			params,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			const { path, edits: rawEdits } = params;
			const absolutePath = resolve(ctx?.cwd ?? process.cwd(), path);

			return withFileMutationQueue(absolutePath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");

				try {
					await access(absolutePath, constants.R_OK | constants.W_OK);
				} catch {
					throw new Error(`File not found or not writable: ${path}`);
				}

				const rawContent = await readFile(absolutePath, "utf-8");
				const hasBom = rawContent.startsWith("\uFEFF");
				const content = hasBom ? rawContent.slice(1) : rawContent;
				const lineEnding = detectLineEnding(content);
				const normalized = normalizeLineEndings(content);

				const edits = parseRawEdits(rawEdits, path);

				if (signal?.aborted) throw new Error("Operation aborted");

				// Apply edits (validates hashes, applies bottom-up)
				const { result: newNormalized, firstChangedLine, warnings } = applyHashlineEdits(normalized, edits);

				if (normalized === newNormalized) {
					throw new Error(`No changes would be made to ${path}. The edits produce identical content.`);
				}

				// Restore line endings and BOM
				const finalContent = (hasBom ? "\uFEFF" : "") + restoreLineEndings(newNormalized, lineEnding);
				await writeFile(absolutePath, finalContent, "utf-8");

				if (signal?.aborted) throw new Error("Operation aborted");

				// Generate diff for display
				const { diff } = generateEditDiff(normalized, edits, newNormalized);

				const warningText = warnings.length > 0 ? `\nWarnings:\n${warnings.map((w) => `  - ${w}`).join("\n")}` : "";

					return {
						content: [
							{
								type: "text",
								text: `Successfully edited ${path}.${warningText}`,
							},
						],
						details: { diff, firstChangedLine },
					};
			});
		},
		renderCall(args, theme, context) {
			if (context.argsComplete && args?.path && args?.edits) {
				const argsKey = JSON.stringify({ path: args.path, edits: args.edits });
				if ((context.state as EditRenderState)?.argsKey !== argsKey) {
					(context.state as EditRenderState).argsKey = argsKey;
					computeEditPreview(args.path, args.edits, context.cwd).then((preview) => {
						if ((context.state as EditRenderState).argsKey === argsKey) {
							(context.state as EditRenderState).preview = preview;
							context.invalidate();
						}
					}).catch((err) => {
						if ((context.state as EditRenderState).argsKey === argsKey) {
							(context.state as EditRenderState).preview = { error: err?.message ?? String(err) };
							context.invalidate();
						}
					});
				}
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let content = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", args?.path)}`;

			const preview = (context.state as EditRenderState)?.preview;
			if (preview) {
				if ("error" in preview) {
					content += `\n\n${theme.fg("error", preview.error)}`;
				} else if (preview.diff) {
					content += `\n\n${renderDiff(preview.diff, { filePath: args?.path })}`;
				}
			}

			text.setText(content);
			return text;
		},
		renderResult(result, options, theme, context) {
			if (context.isError) {
				const errorText = result.content[0]?.text ?? "Unknown error";
				return new Text(`\n${theme.fg("error", errorText)}`, 0, 0);
			}

			const diff = result.details?.diff;
			const state = context.state as EditRenderState;
			const previewDiff = state?.preview && !("error" in state.preview) ? state.preview.diff : undefined;
			if (diff && diff !== previewDiff) {
				return new Text(`\n${renderDiff(diff, { filePath: context.args?.path })}`, 0, 0);
			}

			return new Container();
		},
	});

	pi.registerTool(readImageTool);
	pi.registerTool(readTool);
	pi.registerTool(editTool);
}
