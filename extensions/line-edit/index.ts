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

import { type ExtensionAPI, withFileMutationQueue, renderDiff, keyHint } from "@mariozechner/pi-coding-agent";
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
	generateSimpleDiff,
	truncateContent,
	type HashlineEdit,
} from "./utils";

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
		const crlf = content.includes("\r\n");
		const normalized = crlf ? content.replace(/\r\n/g, "\n") : content;

		const parsedEdits = parseRawEdits(edits);

		// Apply edits to get preview (validates hashes, generates diff)
		const { result: newNormalized, firstChangedLine } = applyHashlineEdits(normalized, parsedEdits);

		if (normalized === newNormalized) {
			return { error: `No changes would be made. The edits produce identical content.` };
		}

		// Generate diff
		const { diff } = generateSimpleDiff(normalized, newNormalized);

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
				["replace", "replace_range", "insert_after", "insert_before"],
				{
					description:
						"replace: Replace a single line at pos with new content. Use empty content to delete the line. " +
						"replace_range: Replace all lines from pos to end (inclusive). Requires both pos and end. Use empty content to delete the range. " +
						"insert_after: Insert new lines immediately after the line at pos. " +
						"insert_before: Insert new lines immediately before the line at pos.",
				},
			),
			pos: Type.String({
				description: 'Line anchor "LINE#HASH" from read output (e.g. "5#PM"). Identifies which line to act on.',
			}),
			end: Type.Optional(
				Type.String({
					description: 'End anchor "LINE#HASH" for replace_range (inclusive). Required when op is "replace_range".',
				}),
			),
			content: Type.String({
				description: "Replacement or insertion text. Use newlines for multiple lines. Empty string to delete.",
			}),
		}),
	),
});

export default function (pi: ExtensionAPI) {
	// ─── Override read ───────────────────────────────────────────────────
	pi.registerTool({
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
		],
		parameters: readSchema,

			async execute(_toolCallId, params: { path: string; offset?: number; limit?: number }, signal?: AbortSignal) {
				const { path, offset, limit } = params;
				const absolutePath = resolve(process.cwd(), path);

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
			const normalized = content.replace(/\r\n/g, "\n");
			const allLines = normalized.split("\n");
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

			let truncationNotice: string | undefined;
			if (truncated) {
				const endShown = startLineNum + shownLines - 1;
				truncationNotice = `[Showing lines ${startLineNum}-${endShown} of ${totalLines}. Use offset=${endShown + 1} to continue.]`;
			} else if (userLimited) {
				const endShown = startLineNum + selectedLines.length - 1;
				const remaining = totalLines - (startLine + selectedLines.length);
				truncationNotice = `[${remaining} more lines. Use offset=${endShown + 1} to continue.]`;
			}

			const outputText = truncationNotice ? `${truncContent}\n\n${truncationNotice}` : truncContent;

			return {
				content: [{ type: "text" as const, text: outputText }],
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
			const maxLines = options.expanded ? contentLines.length : 10;
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

	// ─── Override edit ───────────────────────────────────────────────────
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a file using LINE#HASH anchors from read output. Supports multiple operations per call. " +
			"Hashes are validated before any changes — stale references are rejected with updated anchors.",
		promptSnippet: "Edit file using LINE#HASH anchors (replace, replace_range, insert_after, insert_before)",
		promptGuidelines: [
			"Always read a file before editing it to get current LINE#HASH anchors.",
			"Read as many lines as you need before a large edit. Do NOT assume context from the lines that you didn't read.",
			"Reference lines by their anchor from read output (e.g. pos: \"6#PM\").",
			"Operations: replace (single line), replace_range (pos to end inclusive), insert_after, insert_before.",
			"Use replace_range with pos and end to delete or replace multiple lines (e.g. op: \"replace_range\", pos: \"5#PM\", end: \"9#NQ\", content: \"\").",
			"content is the replacement/insertion text. Use \\n for multiple lines. Empty string deletes lines.",
			"Multiple edits per call are safe, but avoid too many disjoint edits in one call.",
			"If hashes don't match (file changed), you'll get updated anchors — retry with those.",
			"You do NOT need to reproduce original text. Just reference the LINE#HASH anchor.",
		],
		parameters: editSchema,

		async execute(
			_toolCallId,
			params: {
				path: string;
				edits: Array<{ op: string; pos: string; end?: string; content: string }>;
			},
			signal?: AbortSignal,
		) {
			const { path, edits: rawEdits } = params;
			const absolutePath = resolve(process.cwd(), path);

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
				const crlf = content.includes("\r\n");
				const normalized = crlf ? content.replace(/\r\n/g, "\n") : content;

				const edits = parseRawEdits(rawEdits);

				if (signal?.aborted) throw new Error("Operation aborted");

				// Apply edits (validates hashes, applies bottom-up)
				const { result: newNormalized, firstChangedLine, warnings } = applyHashlineEdits(normalized, edits);

				if (normalized === newNormalized) {
					throw new Error(`No changes would be made to ${path}. The edits produce identical content.`);
				}

				// Restore line endings and BOM
				const finalContent = (hasBom ? "\uFEFF" : "") + (crlf ? newNormalized.replace(/\n/g, "\r\n") : newNormalized);
				await writeFile(absolutePath, finalContent, "utf-8");

				if (signal?.aborted) throw new Error("Operation aborted");

				// Generate diff for display
				const { diff } = generateSimpleDiff(normalized, newNormalized);

				const warningText = warnings.length > 0 ? `\nWarnings:\n${warnings.map((w) => `  - ${w}`).join("\n")}` : "";

				return {
					content: [
						{
							type: "text" as const,
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
}
