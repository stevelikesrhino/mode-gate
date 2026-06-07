import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { extractContent } from "./extract.js";
import { searchWeb } from "./web-search.js";

const MAX_INLINE_CONTENT = 50_000;

function normalizeQuery(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeUrl(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeNumResults(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(20, Math.floor(value)));
}

function formatSearchOutput(answer: string, results: Array<{ title: string; url: string; snippet: string }>): string {
	const lines: string[] = [];
	const trimmedAnswer = answer.trim();
	if (trimmedAnswer) {
		lines.push(trimmedAnswer);
		lines.push("");
		lines.push("---");
		lines.push("");
	}
	lines.push("Sources:");
	if (results.length === 0) {
		lines.push("- None");
		return lines.join("\n");
	}
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		lines.push(`${i + 1}. ${result.title || result.url}`);
		lines.push(`   ${result.url}`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
	}
	return lines.join("\n");
}

function truncateContent(content: string): { text: string; truncated: boolean } {
	if (content.length <= MAX_INLINE_CONTENT) return { text: content, truncated: false };
	return {
		text: `${content.slice(0, MAX_INLINE_CONTENT).trimEnd()}\n\n[Content truncated at ${MAX_INLINE_CONTENT} characters.]`,
		truncated: true,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return a concise answer with source URLs. This is a basic web search tool; use fetch_content separately when you need the readable content from a specific result URL.",
		promptSnippet:
			"Use web_search for basic web research. Pass a single query and optionally numResults.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			numResults: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: 20,
				description: "Number of search results to return (default: 5, max: 20)",
			})),
		}),

		async execute(_toolCallId, params, signal) {
			const query = normalizeQuery(params.query);
			if (!query) {
				return {
					content: [{ type: "text", text: "Error: No query provided." }],
					details: { error: "No query provided" },
				};
			}

			const numResults = normalizeNumResults(params.numResults);
			try {
				const result = await searchWeb(query, { numResults, signal });
				return {
					content: [{ type: "text", text: formatSearchOutput(result.answer, result.results) }],
					details: {
						query,
						numResults,
						resultCount: result.results.length,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: { query, numResults, error: message },
				};
			}
		},

		renderCall(args, theme) {
			const query = normalizeQuery((args as { query?: unknown }).query);
			const display = query.length > 70 ? query.slice(0, 67) + "..." : query || "(no query)";
			return new Text(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg(query ? "accent" : "error", display), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { error?: string; resultCount?: number };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const summary = theme.fg("success", `${details?.resultCount ?? 0} sources`);
			if (!expanded) return new Text(summary, 0, 0);
			const text = result.content.find((c) => c.type === "text")?.text ?? "";
			const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch a single HTTP(S) URL and extract readable page content as markdown.",
		promptSnippet:
			"Use fetch_content to read the content of a specific web page URL returned by web_search or supplied by the user.",
		parameters: Type.Object({
			url: Type.String({ description: "HTTP or HTTPS URL to fetch and extract" }),
		}),

		async execute(_toolCallId, params, signal) {
			const url = normalizeUrl(params.url);
			if (!url) {
				return {
					content: [{ type: "text", text: "Error: No URL provided." }],
					details: { error: "No URL provided" },
				};
			}

			const result = await extractContent(url, signal);
			if (result.error) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					details: { url, error: result.error },
				};
			}

			const truncated = truncateContent(result.content);
			const text = [`# ${result.title || url}`, "", truncated.text].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					url,
					title: result.title,
					characters: result.content.length,
					truncated: truncated.truncated,
				},
			};
		},

		renderCall(args, theme) {
			const url = normalizeUrl((args as { url?: unknown }).url);
			const display = url.length > 70 ? url.slice(0, 67) + "..." : url || "(no url)";
			return new Text(theme.fg("toolTitle", theme.bold("fetch_content ")) + theme.fg(url ? "accent" : "error", display), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { error?: string; title?: string; characters?: number; truncated?: boolean };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			let summary = theme.fg("success", "content extracted");
			if (typeof details?.characters === "number") summary += theme.fg("muted", ` (${details.characters} chars)`);
			if (details?.truncated) summary += theme.fg("warning", " truncated");
			if (!expanded) return new Text(summary, 0, 0);
			const text = result.content.find((c) => c.type === "text")?.text ?? "";
			const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});
}
