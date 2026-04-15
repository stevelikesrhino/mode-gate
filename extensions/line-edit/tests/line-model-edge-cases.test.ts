import assert from "node:assert/strict";
import test from "node:test";

import {
	applyHashlineEdits,
	detectLineEnding,
	formatLineTag,
	generateEditDiff,
	generateSimpleDiff,
	parseDocument,
	parseRawEdits,
	restoreLineEndings,
} from "../utils.ts";

function replaceLineWith(content: string, line: number, oldLine: string, replacement: string): string {
	const anchor = formatLineTag(line, oldLine);
	const edits = parseRawEdits(
		[{ op: "replace", pos: anchor, end: anchor, content: replacement }],
		"edge-case.txt",
	);
	return applyHashlineEdits(content, edits).result;
}

function replaceRangeWith(
	content: string,
	startLine: number,
	startText: string,
	endLine: number,
	endText: string,
	replacement: string,
): string {
	const edits = parseRawEdits(
		[{
			op: "replace",
			pos: formatLineTag(startLine, startText),
			end: formatLineTag(endLine, endText),
			content: replacement,
		}],
		"edge-case.txt",
	);
	return applyHashlineEdits(content, edits).result;
}

function insertAfter(content: string, line: number, oldLine: string, insertion: string): string {
	const edits = parseRawEdits(
		[{ op: "insert_after", pos: formatLineTag(line, oldLine), content: insertion }],
		"edge-case.txt",
	);
	return applyHashlineEdits(content, edits).result;
}

function insertBefore(content: string, line: number, oldLine: string, insertion: string): string {
	const edits = parseRawEdits(
		[{ op: "insert_before", pos: formatLineTag(line, oldLine), content: insertion }],
		"edge-case.txt",
	);
	return applyHashlineEdits(content, edits).result;
}

test("parseDocument does not expose a final newline as a phantom line", () => {
	assert.deepEqual(parseDocument("hello\n"), {
		lines: ["hello"],
		finalNewline: true,
	});
});

test("parseDocument preserves a real trailing blank line", () => {
	assert.deepEqual(parseDocument("hello\n\n"), {
		lines: ["hello", ""],
		finalNewline: true,
	});
});

test("deleting the last line after a blank line preserves that blank line", () => {
	const original = "A\n\nB\n\nhello";

	assert.equal(
		replaceLineWith(original, 5, "hello", ""),
		"A\n\nB\n\n",
	);
});

test("deleting the final content line preserves an existing EOF newline", () => {
	const original = "A\nhello\n";

	assert.equal(
		replaceLineWith(original, 2, "hello", ""),
		"A\n",
	);
});

test("deleting the only line in an EOF-newline file produces an empty file", () => {
	assert.equal(
		replaceLineWith("hello\n", 1, "hello", ""),
		"",
	);
});

test("diff deleting the only line renders a deletion, not a blank replacement", () => {
	assert.equal(
		generateSimpleDiff("hello\n", "").diff,
		"-1 hello",
	);
});

test("replacement content preserves a trailing newline as a blank final line", () => {
	assert.equal(
		replaceLineWith("old", 1, "old", "new\n"),
		"new\n\n",
	);
});

test("multi-line replacement preserves interior blank lines", () => {
	assert.equal(
		replaceLineWith("old\n", 1, "old", "A\n\nB"),
		"A\n\nB\n",
	);
});

test("range deletion preserves surrounding blank lines", () => {
	assert.equal(
		replaceRangeWith("A\n\nB\nC\n\nD", 3, "B", 4, "C", ""),
		"A\n\n\nD",
	);
});

test("range replacement with trailing newline creates a real trailing blank line", () => {
	assert.equal(
		replaceRangeWith("A\nB\nC", 2, "B", 3, "C", "X\n"),
		"A\nX\n\n",
	);
});

test("insert_after with empty content inserts a blank line", () => {
	assert.equal(
		insertAfter("A\nB", 1, "A", ""),
		"A\n\nB",
	);
});

test("insert_before with trailing newline inserts a blank logical line", () => {
	assert.equal(
		insertBefore("A\nB", 2, "B", "X\n"),
		"A\nX\n\nB",
	);
});

test("multiple edits apply bottom-up without shifting earlier anchors", () => {
	const first = { op: "replace", pos: formatLineTag(1, "A"), end: formatLineTag(1, "A"), content: "AA" };
	const second = { op: "replace", pos: formatLineTag(3, "C"), end: formatLineTag(3, "C"), content: "CC" };
	const edits = parseRawEdits([first, second], "edge-case.txt");

	assert.equal(
		applyHashlineEdits("A\nB\nC", edits).result,
		"AA\nB\nCC",
	);
});

test("editing normalized CRLF content can be restored to CRLF", () => {
	const original = "A\r\nB\r\n";
	const normalized = original.replace(/\r\n/g, "\n");
	const edited = replaceLineWith(normalized, 2, "B", "BB");

	assert.equal(
		restoreLineEndings(edited, detectLineEnding(original)),
		"A\r\nBB\r\n",
	);
});

test("editing normalized classic Mac CR content can be restored to CR", () => {
	const original = "A\rB\r";
	const normalized = original.replace(/\r/g, "\n");
	const edited = replaceLineWith(normalized, 2, "B", "BB");

	assert.equal(
		restoreLineEndings(edited, detectLineEnding(original)),
		"A\rBB\r",
	);
});

test("diff renders EOF newline additions explicitly", () => {
	assert.equal(
		generateSimpleDiff("hello", "hello\n").diff,
		" 1 hello\n+2 <EOF newline>",
	);
});

test("diff renders EOF newline removals explicitly", () => {
	assert.equal(
		generateSimpleDiff("hello\n", "hello").diff,
		" 1 hello\n-2 <EOF newline>",
	);
});

test("diff renders trailing blank lines as real lines, not EOF markers", () => {
	assert.equal(
		generateSimpleDiff("hello\n\n", "hello\n").diff,
		" 1 hello\n-2 ",
	);
});

test("diff deleting a final line after a blank line does not add an EOF marker", () => {
	assert.equal(
		generateSimpleDiff("A\n\nB\n\nhello", "A\n\nB\n\n").diff,
		" 1 A\n 2 \n 3 B\n 4 \n-5 hello",
	);
});

test("diff uses ellipsis between distant edit spots", () => {
	assert.equal(
		generateSimpleDiff(
			"one\ntwo\nthree\nfour\nfive\nsix\nseven",
			"ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN",
			1,
		).diff,
		"-1 one\n+1 ONE\n 2 two\n   ...\n 6 six\n-7 seven\n+7 SEVEN",
	);
});

test("diff uses ellipsis between unlimited distant edit spots", () => {
	const oldContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n");
	const newContent = oldContent
		.replace("line1", "LINE1")
		.replace("line8", "LINE8")
		.replace("line15", "LINE15");

	assert.equal(
		generateSimpleDiff(oldContent, newContent, 1).diff,
		[
			"- 1 line1",
			"+ 1 LINE1",
			"  2 line2",
			"    ...",
			"  7 line7",
			"- 8 line8",
			"+ 8 LINE8",
			"  9 line9",
			"    ...",
			" 14 line14",
			"-15 line15",
			"+15 LINE15",
		].join("\n"),
	);
});

test("edit diff renders unlimited anchored edits without sliding repeated blank lines", () => {
	const oldLines = Array.from({ length: 200 }, () => "");
	oldLines[0] = "aaa";
	oldLines[1] = "bbb";
	oldLines[2] = "cc";
	oldLines[3] = "ddd";
	oldLines[199] = "https://github.com/ggml-org/llama.cpp/pull/21896";
	const oldContent = oldLines.join("\n");
	const rawEdits = [
		{ op: "replace", pos: formatLineTag(1, "aaa"), end: formatLineTag(1, "aaa"), content: "LINE1!!!" },
		{ op: "replace", pos: formatLineTag(50, ""), end: formatLineTag(50, ""), content: "LINE50!!!" },
		{ op: "replace", pos: formatLineTag(100, ""), end: formatLineTag(100, ""), content: "LINE100!!!" },
		{ op: "replace", pos: formatLineTag(150, ""), end: formatLineTag(150, ""), content: "LINE150!!!" },
		{ op: "replace", pos: formatLineTag(200, oldLines[199]), end: formatLineTag(200, oldLines[199]), content: "" },
	];
	const edits = parseRawEdits(rawEdits, "TEST.md");
	const newContent = applyHashlineEdits(oldContent, edits).result;

	assert.equal(
		generateEditDiff(oldContent, edits, newContent).diff,
		[
			"-  1 aaa",
			"+  1 LINE1!!!",
			"   2 bbb",
			"   3 cc",
			"   4 ddd",
			"   5 ",
			"     ...",
			"  46 ",
			"  47 ",
			"  48 ",
			"  49 ",
			"- 50 ",
			"+ 50 LINE50!!!",
			"  51 ",
			"  52 ",
			"  53 ",
			"  54 ",
			"     ...",
			"  96 ",
			"  97 ",
			"  98 ",
			"  99 ",
			"-100 ",
			"+100 LINE100!!!",
			" 101 ",
			" 102 ",
			" 103 ",
			" 104 ",
			"     ...",
			" 146 ",
			" 147 ",
			" 148 ",
			" 149 ",
			"-150 ",
			"+150 LINE150!!!",
			" 151 ",
			" 152 ",
			" 153 ",
			" 154 ",
			"     ...",
			" 196 ",
			" 197 ",
			" 198 ",
			" 199 ",
			"-200 https://github.com/ggml-org/llama.cpp/pull/21896",
		].join("\n"),
	);
});

test("line ending helpers preserve Windows and classic Mac styles", () => {
	assert.equal(detectLineEnding("a\r\nb\r\n"), "\r\n");
	assert.equal(restoreLineEndings("a\nb\n", "\r\n"), "a\r\nb\r\n");

	assert.equal(detectLineEnding("a\rb\r"), "\r");
	assert.equal(restoreLineEndings("a\nb\n", "\r"), "a\rb\r");
});
