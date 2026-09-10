/**
 * Read Image Extension
 *
 * Registers read_image: reads an image file through pi's native image
 * pipeline (MIME detection, auto-resize, vision attachment) and rejects
 * paths that are not supported images.
 */

import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export default function readImageExtension(pi: ExtensionAPI): void {
	const nativeRead = createReadToolDefinition(process.cwd());

	pi.registerTool({
		...nativeRead,
		name: "read_image",
		label: "read image",
		description: "Read an image file (jpg, png, gif, webp, bmp) and send it as an attachment.",
		promptSnippet: "View image file contents",
		promptGuidelines: ["Use read_image whenever you need to see an image file's contents."],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the image file (relative or absolute)" }),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await nativeRead.execute(toolCallId, { path: params.path }, signal, onUpdate, ctx);
			const isImage =
				result.content.some((part) => part.type === "image") ||
				result.content.some((part) => part.type === "text" && part.text.startsWith("Read image file ["));
			if (!isImage) throw new Error(`Not an image file: ${params.path}`);
			return result;
		},
		renderCall(args, theme, context) {
			// The native renderer hardcodes a "read" title for this call line.
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("read_image"))} ${theme.fg("accent", String(args?.path ?? ""))}`,
			);
			return text;
		},
	});
}
