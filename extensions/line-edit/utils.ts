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
	constructor(
		public readonly mismatches: HashMismatch[],
		public readonly fileLines: string[],
	) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";
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
	| { op: "replace"; pos: Anchor; lines: string[] }
	| { op: "replace_range"; pos: Anchor; end: Anchor; lines: string[] }
	| { op: "insert_after"; pos: Anchor; lines: string[] }
	| { op: "insert_before"; pos: Anchor; lines: string[] };

// --- Parse raw edits ---

function parseEditContent(content: string): string[] {
	if (content === "") return [];

	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.split("\n");
}

function stripTrailingWhitespace(text: string): string {
	const parts = text.split(/(\r\n|\n|\r)/);
	let result = "";

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === undefined) continue;
		result += i % 2 === 0 ? part.replace(/\s+$/g, "") : part;
	}

	return result;
}

function normalizeEditContent(content: string, filePath: string): string {
	const isMarkdown = /\.(md|mdx)$/i.test(filePath);
	return isMarkdown ? content : stripTrailingWhitespace(content);
}

export function parseRawEdits(
	rawEdits: Array<{ op: string; pos: string; end?: string; content: string }>,
	filePath: string,
): HashlineEdit[] {
	return rawEdits.map((raw) => {
		const lines = parseEditContent(normalizeEditContent(raw.content, filePath));

		switch (raw.op) {
			case "replace": {
				return { op: "replace", pos: parseTag(raw.pos), lines };
			}
			case "replace_range": {
				if (!raw.end) {
					throw new Error(`replace_range requires an "end" anchor.`);
				}
				return { op: "replace_range", pos: parseTag(raw.pos), end: parseTag(raw.end), lines };
			}
			case "insert_after": {
				return { op: "insert_after", pos: parseTag(raw.pos), lines };
			}
			case "insert_before": {
				return { op: "insert_before", pos: parseTag(raw.pos), lines };
			}
			default:
				throw new Error(`Unknown op "${raw.op}". Valid: replace, replace_range, insert_after, insert_before`);
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

	const fileLines = text.split("\n");
	const originalFileLines = [...fileLines];
	let firstChangedLine: number | undefined;
	const warnings: string[] = [];

	// Pre-validate all hashes before mutating
	const mismatches: HashMismatch[] = [];
	for (const edit of edits) {
		switch (edit.op) {
			case "replace": {
				validateRef(edit.pos, fileLines, mismatches);
				break;
			}
			case "replace_range": {
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
				if (edit.lines.length === 0) edit.lines = [""];
				break;
		}
	}
	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, fileLines);
	}

	validateEditConflicts(edits);

	// Boundary duplication warning
	for (const edit of edits) {
		if (edit.op !== "replace" && edit.op !== "replace_range") continue;
		const endLine = edit.op === "replace_range" ? edit.end.line : edit.pos.line;
		if (edit.lines.length === 0) continue;
		const nextIdx = endLine; // 0-indexed next surviving line
		if (nextIdx >= originalFileLines.length) continue;
		const trimmedNext = originalFileLines[nextIdx].trim();
		const trimmedLast = edit.lines[edit.lines.length - 1].trim();
		if (trimmedLast.length > 0 && trimmedLast === trimmedNext) {
			const tag = formatLineTag(endLine + 1, originalFileLines[nextIdx]);
			warnings.push(
				`Possible boundary duplication: last replacement line "${trimmedLast}" matches next surviving line ${tag}. ` +
					`If replacing the full block, set end to ${tag}.`,
			);
		}
	}

	// Deduplicate identical edits
	const seen = new Set<string>();
	const deduped: Array<{ edit: HashlineEdit; idx: number }> = [];
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		let key: string;
		switch (edit.op) {
			case "replace":
				key = `r:${edit.pos.line}::${edit.lines.join("\n")}`;
				break;
			case "replace_range":
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
				sortLine = edit.pos.line;
				precedence = 0;
				break;
			case "replace_range":
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
				const orig = fileLines[edit.pos.line - 1];
				if (edit.lines.length === 1 && edit.lines[0] === orig) break; // noop
				fileLines.splice(edit.pos.line - 1, 1, ...edit.lines);
				track(edit.pos.line);
				break;
			}
			case "replace_range": {
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

	return { result: fileLines.join("\n"), firstChangedLine, warnings };

	function track(line: number) {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	}
}

function getInsertBoundary(edit: Extract<HashlineEdit, { op: "insert_after" | "insert_before" }>): number {
	return edit.op === "insert_before" ? edit.pos.line - 1 : edit.pos.line;
}

function describeEdit(edit: HashlineEdit): string {
	switch (edit.op) {
		case "replace":
			return `replace at line ${edit.pos.line}`;
		case "replace_range":
			return `replace_range ${edit.pos.line}-${edit.end.line}`;
		case "insert_after":
			return `insert_after line ${edit.pos.line}`;
		case "insert_before":
			return `insert_before line ${edit.pos.line}`;
	}
}

function validateEditConflicts(edits: HashlineEdit[]): void {
	const replacements = edits
		.filter((edit): edit is Extract<HashlineEdit, { op: "replace" | "replace_range" }> => edit.op === "replace" || edit.op === "replace_range")
		.map((edit) => ({
			edit,
			start: edit.pos.line,
			end: edit.op === "replace_range" ? edit.end.line : edit.pos.line,
		}))
		.sort((a, b) => a.start - b.start || a.end - b.end);

	for (let i = 1; i < replacements.length; i++) {
		const prev = replacements[i - 1];
		const current = replacements[i];
		if (prev.end >= current.start) {
			throw new Error(
				`Conflicting edits: ${describeEdit(prev.edit)} overlaps with ${describeEdit(current.edit)}. ` +
					`Merge them into one replacement block.`,
			);
		}
	}

	const insertions = new Map<number, { edit: Extract<HashlineEdit, { op: "insert_after" | "insert_before" }>; content: string }>();
	for (const edit of edits) {
		if (edit.op !== "insert_after" && edit.op !== "insert_before") continue;

		const boundary = getInsertBoundary(edit);
		const content = edit.lines.join("\n");
		const existing = insertions.get(boundary);
		if (existing && existing.content !== content) {
			throw new Error(
				`Conflicting edits: ${describeEdit(existing.edit)} and ${describeEdit(edit)} target the same insertion point. ` +
					`Merge them into one insertion.`,
			);
		}
		if (!existing) {
			insertions.set(boundary, { edit, content });
		}
	}

	for (const { edit, start, end } of replacements) {
		for (const [boundary, insertion] of insertions) {
			if (boundary >= start - 1 && boundary <= end) {
				throw new Error(
					`Conflicting edits: ${describeEdit(insertion.edit)} touches the same block as ${describeEdit(edit)}. ` +
						`Merge them into one replacement block.`,
				);
			}
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Diff generation (Myers algorithm via `diff` package)
// ═══════════════════════════════════════════════════════════════════════════

import * as Diff from "diff";

function countContentLines(content: string): number {
	const lines = content.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return Math.max(1, lines.length);
}

function formatDiffLine(prefix: "+" | "-" | " ", lineNum: number, width: number, content: string): string {
	return `${prefix}${String(lineNum).padStart(width)} ${content}`;
}

export function generateSimpleDiff(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const maxLineNum = Math.max(countContentLines(oldContent), countContentLines(newContent));
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

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

	return { diff: output.join("\n"), firstChangedLine };
}

// ═══════════════════════════════════════════════════════════════════════════
// Truncation (simplified from built-in)
// ═══════════════════════════════════════════════════════════════════════════

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

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
