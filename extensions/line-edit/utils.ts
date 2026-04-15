// ═══════════════════════════════════════════════════════════════════════════
// Pure-JS FNV-1a 32-bit hash (replaces Bun.hash.xxHash32)
// ═══════════════════════════════════════════════════════════════════════════

function hash32(str: string, seed: number = 0): number {
	const buf = Buffer.from(str, "utf-8");
	let h = (2166136261 ^ seed) >>> 0;
	for (let i = 0; i < buf.length; i++) {
		h ^= buf[i];
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h >>> 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Hashline core
// ═══════════════════════════════════════════════════════════════════════════

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

const DICT = Array.from({ length: 256 }, (_, i) => {
	const h = i >>> 4;
	const l = i & 0x0f;
	return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});

/**
 * Compute 2-char hash for a line anchored to its 1-indexed line number.
 * This makes the full LINE#HASH token the identity, so the same content on
 * a different line no longer validates as a stale reference.
 */
export function computeLineHash(idx: number, line: string): string {
	line = line.replace(/\r/g, "");
	return DICT[hash32(line, idx) & 0xff];
}

export function formatLineTag(lineNum: number, lineText: string): string {
	return `${lineNum}#${computeLineHash(lineNum, lineText)}`;
}

// --- Tag parsing ---

export interface Anchor {
	line: number;
	hash: string;
}

/**
 * Parse `"LINE#HASH"` reference (e.g. `"5#PM"`) into structured form.
 */
export function parseTag(ref: string): Anchor {
	const match = ref.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/);
	if (!match) {
		throw new Error(`Invalid line reference "${ref}". Expected "LINE#HASH" (e.g. "5#PM").`);
	}
	const line = parseInt(match[1], 10);
	if (line < 1) {
		throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	}
	return { line, hash: match[2] };
}

// --- Hash mismatch error ---

export interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
}

const MISMATCH_CONTEXT = 2;

export class HashlineMismatchError extends Error {
	public readonly mismatches: HashMismatch[];
	public readonly fileLines: string[];

	constructor(
		mismatches: HashMismatch[],
		fileLines: string[],
	) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";
		this.mismatches = mismatches;
		this.fileLines = fileLines;
	}

	static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const mismatchSet = new Map<number, HashMismatch>();
		for (const m of mismatches) mismatchSet.set(m.line, m);

		const displayLines = new Set<number>();
		for (const m of mismatches) {
			const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
			const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
			for (let i = lo; i <= hi; i++) displayLines.add(i);
		}

		const sorted = [...displayLines].sort((a, b) => a - b);
		const out: string[] = [];
		out.push(
			`${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. ` +
				`Use the updated LINE#ID references shown below (>>> marks changed lines).`,
		);
		out.push("");

		let prevLine = -1;
		for (const lineNum of sorted) {
			if (prevLine !== -1 && lineNum > prevLine + 1) out.push("    ...");
			prevLine = lineNum;
			const text = fileLines[lineNum - 1];
			const hash = computeLineHash(lineNum, text);
			const prefix = `${lineNum}#${hash}`;
			if (mismatchSet.has(lineNum)) {
				out.push(`>>> ${prefix}:${text}`);
			} else {
				out.push(`    ${prefix}:${text}`);
			}
		}
		return out.join("\n");
	}
}

// --- Validation ---

export function validateRef(ref: Anchor, fileLines: string[], mismatches: HashMismatch[]): boolean {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
	}
	const actual = computeLineHash(ref.line, fileLines[ref.line - 1]);
	if (actual !== ref.hash) {
		mismatches.push({ line: ref.line, expected: ref.hash, actual });
		return false;
	}
	return true;
}

// --- Edit types ---

export type HashlineEdit =
	| { op: "replace"; pos: Anchor; end: Anchor; lines: string[] }
	| { op: "insert_after"; pos: Anchor; lines: string[] }
	| { op: "insert_before"; pos: Anchor; lines: string[] };

// --- Parse raw edits ---

export interface ParsedDocument {
	lines: string[];
	finalNewline: boolean;
}

export type LineEnding = "\n" | "\r\n" | "\r";

export function detectLineEnding(content: string): LineEnding {
	if (content.includes("\r\n")) return "\r\n";
	if (content.includes("\r")) return "\r";
	return "\n";
}

export function normalizeLineEndings(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(content: string, lineEnding: LineEnding): string {
	return lineEnding === "\n" ? content : content.replace(/\n/g, lineEnding);
}

export function parseDocument(content: string): ParsedDocument {
	const normalized = normalizeLineEndings(content);
	const finalNewline = normalized.endsWith("\n");
	const lines = normalized.split("\n");
	if (finalNewline) {
		lines.pop();
	}
	return { lines, finalNewline };
}

function serializeDocument(doc: ParsedDocument): string {
	if (doc.lines.length === 0) return "";

	const body = doc.lines.join("\n");
	const needsTerminator = doc.finalNewline || doc.lines[doc.lines.length - 1] === "";
	return needsTerminator ? `${body}\n` : body;
}

function parseEditContent(content: string): string[] {
	if (content === "") return [];

	return normalizeLineEndings(content).split("\n");
}

function parseInsertContent(content: string): string[] {
	const lines = parseEditContent(content);
	return lines.length === 0 ? [""] : lines;
}

export function parseRawEdits(
	rawEdits: Array<{ op: string; pos: string; end?: string; content: string }>,
	_filePath: string,
): HashlineEdit[] {
	return rawEdits.map((raw) => {
		switch (raw.op) {
			case "replace": {
				if (!raw.end) {
					throw new Error(`replace requires an "end" anchor.`);
				}
				const lines = parseEditContent(raw.content);
				return { op: "replace", pos: parseTag(raw.pos), end: parseTag(raw.end), lines };
			}
			case "insert_after": {
				const lines = parseInsertContent(raw.content);
				return { op: "insert_after", pos: parseTag(raw.pos), lines };
			}
			case "insert_before": {
				const lines = parseInsertContent(raw.content);
				return { op: "insert_before", pos: parseTag(raw.pos), lines };
			}
			default:
				throw new Error(`Unknown op "${raw.op}". Valid: replace, insert_after, insert_before`);
		}
	});
}

// --- Apply edits ---

export function applyHashlineEdits(
	text: string,
	edits: HashlineEdit[],
): { result: string; firstChangedLine: number | undefined; warnings: string[] } {
	if (edits.length === 0) {
		return { result: text, firstChangedLine: undefined, warnings: [] };
	}

	const doc = parseDocument(text);
	const fileLines = doc.lines;
	let firstChangedLine: number | undefined;
	const warnings: string[] = [];

	// Pre-validate all hashes before mutating
	const mismatches: HashMismatch[] = [];
	for (const edit of edits) {
		switch (edit.op) {
			case "replace": {
				validateRef(edit.pos, fileLines, mismatches);
				validateRef(edit.end, fileLines, mismatches);
				if (edit.pos.line > edit.end.line) {
					throw new Error(`Range start ${edit.pos.line} must be <= end ${edit.end.line}`);
				}
				break;
			}
			case "insert_after":
			case "insert_before":
				validateRef(edit.pos, fileLines, mismatches);
				break;
		}
	}
	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, fileLines);
	}

	const effectiveEdits = edits.filter((edit) => (edit.op !== "insert_after" && edit.op !== "insert_before") || edit.lines.length > 0);
	if (effectiveEdits.length === 0) {
		return { result: text, firstChangedLine: undefined, warnings };
	}

	// Deduplicate identical edits
	const seen = new Set<string>();
	const deduped: Array<{ edit: HashlineEdit; idx: number }> = [];
	for (let i = 0; i < effectiveEdits.length; i++) {
		const edit = effectiveEdits[i];
		let key: string;
		switch (edit.op) {
			case "replace":
				key = `rr:${edit.pos.line}:${edit.end.line}:${edit.lines.join("\n")}`;
				break;
			case "insert_after":
			case "insert_before":
				key = `i:${getInsertBoundary(edit)}:${edit.lines.join("\n")}`;
				break;
		}
		if (!seen.has(key)) {
			seen.add(key);
			deduped.push({ edit, idx: i });
		}
	}

	// Sort bottom-up (highest line first) so splices don't invalidate later indices
	const sorted = deduped.map(({ edit, idx }) => {
		let sortLine: number;
		let precedence: number;
		switch (edit.op) {
			case "replace":
				sortLine = edit.end.line;
				precedence = 0;
				break;
			case "insert_after":
				sortLine = edit.pos.line;
				precedence = 1;
				break;
			case "insert_before":
				sortLine = edit.pos.line;
				precedence = 2;
				break;
		}
		return { edit, idx, sortLine, precedence };
	});
	sorted.sort((a, b) => b.sortLine - a.sortLine || a.precedence - b.precedence || a.idx - b.idx);

	// Apply bottom-up
	for (const { edit } of sorted) {
		switch (edit.op) {
			case "replace": {
				const count = edit.end.line - edit.pos.line + 1;
				fileLines.splice(edit.pos.line - 1, count, ...edit.lines);
				track(edit.pos.line);
				break;
			}
			case "insert_after":
				fileLines.splice(edit.pos.line, 0, ...edit.lines);
				track(edit.pos.line + 1);
				break;
			case "insert_before":
				fileLines.splice(edit.pos.line - 1, 0, ...edit.lines);
				track(edit.pos.line);
				break;
		}
	}

	return { result: serializeDocument(doc), firstChangedLine, warnings };

	function track(line: number) {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	}
}

function getInsertBoundary(edit: Extract<HashlineEdit, { op: "insert_after" | "insert_before" }>): number {
	return edit.op === "insert_before" ? edit.pos.line - 1 : edit.pos.line;
}

// ═══════════════════════════════════════════════════════════════════════════
// Diff generation (Myers algorithm via `diff` package)
// ═══════════════════════════════════════════════════════════════════════════

import * as Diff from "diff";

function countContentLines(content: string): number {
	return Math.max(1, parseDiffDocument(content).lines.length);
}

function formatDiffLine(prefix: "+" | "-" | " ", lineNum: number, width: number, content: string): string {
	return `${prefix}${String(lineNum).padStart(width)} ${content}`;
}

function formatDiffEllipsis(width: number): string {
	return ` ${"".padStart(width, " ")} ...`;
}

function sameLines(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((line, i) => line === right[i]);
}

function shouldShowEofNewlineChange(oldDoc: ParsedDocument, newDoc: ParsedDocument): boolean {
	if (oldDoc.finalNewline === newDoc.finalNewline) return false;

	const oldLastLine = oldDoc.lines[oldDoc.lines.length - 1] ?? "";
	const newLastLine = newDoc.lines[newDoc.lines.length - 1] ?? "";

	return sameLines(oldDoc.lines, newDoc.lines) || (oldLastLine !== "" && newLastLine !== "");
}

function appendContextBeforeEof(
	output: string[],
	lines: string[],
	lineNumWidth: number,
	contextLines: number,
): void {
	const start = Math.max(0, lines.length - contextLines);
	for (let i = start; i < lines.length; i++) {
		output.push(formatDiffLine(" ", i + 1, lineNumWidth, lines[i]));
	}
}

function parseDiffDocument(content: string): ParsedDocument {
	if (content === "") return { lines: [], finalNewline: false };
	return parseDocument(content);
}

type EditDiffHunk = {
	start: number;
	end: number;
	edits: HashlineEdit[];
};

function getEditRange(edit: HashlineEdit): { start: number; end: number } {
	switch (edit.op) {
		case "replace":
			return { start: edit.pos.line, end: edit.end.line };
		case "insert_before":
		case "insert_after":
			return { start: edit.pos.line, end: edit.pos.line };
	}
}

function buildEditDiffHunks(edits: HashlineEdit[], oldLineCount: number, contextLines: number): EditDiffHunk[] {
	const sorted = [...edits].sort((a, b) => {
		const left = getEditRange(a);
		const right = getEditRange(b);
		return left.start - right.start || left.end - right.end;
	});

	const hunks: EditDiffHunk[] = [];
	for (const edit of sorted) {
		const range = getEditRange(edit);
		const start = Math.max(1, range.start - contextLines);
		const end = Math.min(oldLineCount, range.end + contextLines);
		const last = hunks[hunks.length - 1];

		if (last && start <= last.end + 1) {
			last.end = Math.max(last.end, end);
			last.edits.push(edit);
		} else {
			hunks.push({ start, end, edits: [edit] });
		}
	}
	return hunks;
}

function appendContextLines(
	output: string[],
	lines: string[],
	from: number,
	to: number,
	lineNumWidth: number,
): void {
	for (let lineNum = from; lineNum <= to; lineNum++) {
		const line = lines[lineNum - 1];
		if (line === undefined) continue;
		output.push(formatDiffLine(" ", lineNum, lineNumWidth, line));
	}
}

function appendAddedLines(
	output: string[],
	startLine: number,
	lines: string[],
	lineNumWidth: number,
): void {
	for (let i = 0; i < lines.length; i++) {
		output.push(formatDiffLine("+", startLine + i, lineNumWidth, lines[i]));
	}
}

function appendRemovedLines(
	output: string[],
	oldLines: string[],
	from: number,
	to: number,
	lineNumWidth: number,
): void {
	for (let lineNum = from; lineNum <= to; lineNum++) {
		output.push(formatDiffLine("-", lineNum, lineNumWidth, oldLines[lineNum - 1] ?? ""));
	}
}

export function generateEditDiff(
	oldContent: string,
	edits: HashlineEdit[],
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const oldDoc = parseDiffDocument(oldContent);
	const newDoc = parseDiffDocument(newContent);
	const showEofNewlineChange = shouldShowEofNewlineChange(oldDoc, newDoc);
	const output: string[] = [];
	const eofLineNum = Math.max(oldDoc.lines.length, newDoc.lines.length) + 1;
	const maxLineNum = Math.max(
		oldDoc.lines.length,
		newDoc.lines.length,
		showEofNewlineChange ? eofLineNum : 1,
		1,
	);
	const lineNumWidth = String(maxLineNum).length;
	let firstChangedLine: number | undefined;
	let previousHunkEnd: number | undefined;

	for (const hunk of buildEditDiffHunks(edits, oldDoc.lines.length, contextLines)) {
		if (previousHunkEnd !== undefined && hunk.start > previousHunkEnd + 1) {
			output.push(formatDiffEllipsis(lineNumWidth));
		}
		previousHunkEnd = hunk.end;

		let cursor = hunk.start;
		for (const edit of hunk.edits) {
			const range = getEditRange(edit);

			if (edit.op === "insert_after") {
				appendContextLines(output, oldDoc.lines, cursor, edit.pos.line, lineNumWidth);
				cursor = edit.pos.line + 1;
				appendAddedLines(output, edit.pos.line + 1, edit.lines, lineNumWidth);
				if (firstChangedLine === undefined) firstChangedLine = edit.pos.line + 1;
				continue;
			}

			appendContextLines(output, oldDoc.lines, cursor, range.start - 1, lineNumWidth);

			if (edit.op === "insert_before") {
				appendAddedLines(output, edit.pos.line, edit.lines, lineNumWidth);
				if (firstChangedLine === undefined) firstChangedLine = edit.pos.line;
			} else {
				appendRemovedLines(output, oldDoc.lines, edit.pos.line, edit.end.line, lineNumWidth);
				appendAddedLines(output, edit.pos.line, edit.lines, lineNumWidth);
				cursor = edit.end.line + 1;
				if (firstChangedLine === undefined) firstChangedLine = edit.pos.line;
			}
		}

		appendContextLines(output, oldDoc.lines, cursor, hunk.end, lineNumWidth);
	}

	if (showEofNewlineChange) {
		if (output.length === 0) {
			appendContextBeforeEof(output, oldDoc.lines, lineNumWidth, contextLines);
		} else if (previousHunkEnd !== undefined && oldDoc.lines.length - previousHunkEnd > contextLines) {
			output.push(formatDiffEllipsis(lineNumWidth));
			appendContextBeforeEof(output, oldDoc.lines, lineNumWidth, contextLines);
		}

		if (oldDoc.finalNewline) {
			output.push(formatDiffLine("-", oldDoc.lines.length + 1, lineNumWidth, "<EOF newline>"));
		} else {
			output.push(formatDiffLine("+", newDoc.lines.length + 1, lineNumWidth, "<EOF newline>"));
		}

		if (firstChangedLine === undefined) {
			firstChangedLine = newDoc.lines.length + 1;
		}
	}

	if (output.length === 0) {
		return generateSimpleDiff(oldContent, newContent, contextLines);
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export function generateSimpleDiff(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const oldDoc = parseDiffDocument(oldContent);
	const newDoc = parseDiffDocument(newContent);
	const showEofNewlineChange = shouldShowEofNewlineChange(oldDoc, newDoc);
	const parts = Diff.diffArrays(oldDoc.lines, newDoc.lines);
	const output: string[] = [];

	const eofLineNum = Math.max(oldDoc.lines.length, newDoc.lines.length) + 1;
	const maxLineNum = Math.max(
		countContentLines(oldContent),
		countContentLines(newContent),
		showEofNewlineChange ? eofLineNum : 1,
	);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value;

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			for (const line of raw) {
				if (part.added) {
					output.push(formatDiffLine("+", newLineNum, lineNumWidth, line));
					newLineNum++;
				} else {
					output.push(formatDiffLine("-", oldLineNum, lineNumWidth, line));
					oldLineNum++;
				}
			}
			lastWasChange = true;
			} else {
				const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

				if (lastWasChange || nextPartIsChange) {
					let linesToShow = raw;
					let skipStart = 0;
					let skipEnd = 0;

					if (lastWasChange && nextPartIsChange && raw.length > contextLines * 2) {
						const leadingLines = raw.slice(0, contextLines);
						const trailingLines = raw.slice(raw.length - contextLines);
						const skippedLines = raw.length - leadingLines.length - trailingLines.length;

						for (const line of leadingLines) {
							output.push(formatDiffLine(" ", oldLineNum, lineNumWidth, line));
							oldLineNum++;
							newLineNum++;
						}

						output.push(formatDiffEllipsis(lineNumWidth));
						oldLineNum += skippedLines;
						newLineNum += skippedLines;

						for (const line of trailingLines) {
							output.push(formatDiffLine(" ", oldLineNum, lineNumWidth, line));
							oldLineNum++;
							newLineNum++;
						}

						lastWasChange = false;
						continue;
					}

					if (!lastWasChange) {
						skipStart = Math.max(0, raw.length - contextLines);
						linesToShow = raw.slice(skipStart);
					}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				oldLineNum += skipStart;
				newLineNum += skipStart;

				for (const line of linesToShow) {
					output.push(formatDiffLine(" ", oldLineNum, lineNumWidth, line));
					oldLineNum++;
					newLineNum++;
				}

				oldLineNum += skipEnd;
				newLineNum += skipEnd;
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	if (showEofNewlineChange) {
		if (output.length === 0) {
			appendContextBeforeEof(output, oldDoc.lines, lineNumWidth, contextLines);
		}

		if (oldDoc.finalNewline) {
			output.push(formatDiffLine("-", oldDoc.lines.length + 1, lineNumWidth, "<EOF newline>"));
		} else {
			output.push(formatDiffLine("+", newDoc.lines.length + 1, lineNumWidth, "<EOF newline>"));
		}

		if (firstChangedLine === undefined) {
			firstChangedLine = newDoc.lines.length + 1;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

// ═══════════════════════════════════════════════════════════════════════════
// Truncation (simplified from built-in)
// ═══════════════════════════════════════════════════════════════════════════

const MAX_LINES = 2000;
const MAX_BYTES = 20 * 1024;

export function truncateContent(text: string): { content: string; truncated: boolean; totalLines: number; shownLines: number } {
	const lines = text.split("\n");
	const totalLines = lines.length;
	const totalBytes = Buffer.byteLength(text, "utf-8");

	if (totalLines <= MAX_LINES && totalBytes <= MAX_BYTES) {
		return { content: text, truncated: false, totalLines, shownLines: totalLines };
	}

	const out: string[] = [];
	let bytes = 0;
	for (let i = 0; i < lines.length && i < MAX_LINES; i++) {
		const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
		if (bytes + lineBytes > MAX_BYTES) break;
		out.push(lines[i]);
		bytes += lineBytes;
	}

	return { content: out.join("\n"), truncated: true, totalLines, shownLines: out.length };
}
