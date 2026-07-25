/**
 * My Read Extension
 *
 * Overrides the built-in read tool narrowly:
 * - delegates execution to createReadToolDefinition()
 * - prefixes text-file output with file line numbers
 * - renders a collapsed preview of the numbered output
 */

import { createReadToolDefinition, keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type ReadParams = {
	path: string;
	offset?: number;
	limit?: number;
};

function readStartLine(params: ReadParams): number {
	if (!Number.isFinite(params.offset)) return 1;
	return Math.max(1, Math.floor(params.offset ?? 1));
}

function splitCoreReadNotice(text: string): { body: string; suffix: string } {
	const match = text.match(/\n\n\[(?:Showing lines \d+-\d+ of \d+.*|[0-9]+ more lines in file\..*)\]$/);
	if (!match?.index) return { body: text, suffix: "" };
	return {
		body: text.slice(0, match.index),
		suffix: text.slice(match.index),
	};
}

function shouldNumberText(text: string): boolean {
	if (text.startsWith("Read image file [")) return false;
	if (/^\[Line \d+ is .*, exceeds .* limit\./.test(text)) return false;
	return text.length > 0;
}

function addLineNumbers(text: string, startLine: number): string {
	const { body, suffix } = splitCoreReadNotice(text);
	if (!shouldNumberText(body)) return text;

	const lines = body.replace(/\r/g, "").split("\n");
	const width = String(startLine + lines.length - 1).length;
	const numbered = lines
		.map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`)
		.join("\n");
	return numbered + suffix;
}

export default function myReadExtension(pi: ExtensionAPI): void {
	const systemReadTool = createReadToolDefinition(process.cwd());

	pi.registerTool({
		...systemReadTool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await systemReadTool.execute(toolCallId, params, signal, onUpdate, ctx);
			const startLine = readStartLine(params as ReadParams);
			return {
				...result,
				content: result.content.map((part) => {
					if (part.type !== "text") return part;
					return {
						...part,
						text: addLineNumbers(part.text, startLine),
					};
				}),
			};
		},
		renderResult(result, options, theme, context) {
			if (options.expanded || context.isError) {
				return systemReadTool.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
			}

			const textParts = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text);
			if (textParts.length === 0) {
				return systemReadTool.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
			}

			const lines = textParts.join("\n").split("\n");
			const maxLines = 10;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - displayLines.length;
			let output = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;

			if (remaining > 0) {
				output += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	});
}
