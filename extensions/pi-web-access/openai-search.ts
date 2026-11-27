import type { WebSearchResponse, WebSearchResult } from "./web-search.ts";

interface Source {
	url?: string;
	title?: string;
}

interface OutputItem {
	type: string;
	status?: string;
	action?: { sources?: Source[] };
	content?: Array<{
		type: string;
		text?: string;
		annotations?: Array<Source & { type: string }>;
	}>;
}

interface OpenAIResponse {
	status?: string;
	output?: OutputItem[];
}

function maxToolCalls(): number {
	const raw = process.env.PI_WEB_SEARCH_MAX_TOOL_CALLS?.trim();
	if (!raw) return 3;

	const limit = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1) {
		throw new Error("PI_WEB_SEARCH_MAX_TOOL_CALLS must be a positive integer.");
	}
	return limit;
}

export async function searchOpenAI(query: string, numResults: number, signal: AbortSignal): Promise<WebSearchResponse> {
	const key = process.env.OAI_PLATFORM_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
	if (!key) throw new Error("OpenAI web search requires OAI_PLATFORM_KEY or OPENAI_API_KEY.");

	const response = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: process.env.PI_WEB_SEARCH_MODEL?.trim() || "gpt-6-luna",
			tools: [{ type: "web_search" }],
			tool_choice: "required",
			max_tool_calls: maxToolCalls(),
			include: ["web_search_call.action.sources"],
			store: false,
			instructions: `Answer concisely with inline citations. Use up to ${numResults} sources.`,
			input: query,
		}),
		signal,
	});
	if (!response.ok) {
		// Authentication errors can echo part of the key. Don't pass raw error messages to Pi.
		const error = (await response.json().catch(() => null))?.error;
		const code = typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? `: ${error.code}` : "";
		throw new Error(`OpenAI web search failed (HTTP ${response.status}${code}).`);
	}

	const data: OpenAIResponse = await response.json();
	const output = data.output ?? [];
	const searches = output.filter(item => item.type === "web_search_call" && item.status === "completed");
	if (data.status !== "completed" || !searches.length) throw new Error("OpenAI did not complete the web search.");

	const parts = output.filter(item => item.type === "message").flatMap(item => item.content ?? [])
		.filter(part => part.type === "output_text");
	const answer = parts.map(part => part.text).join("\n\n").trim();
	if (!answer) throw new Error("OpenAI web search returned no answer.");

	// Prefer cited pages; fill remaining slots with other URLs actually consulted by the search.
	const cited = parts.flatMap(part => part.annotations ?? []).filter(note => note.type === "url_citation");
	const consulted = searches.flatMap(item => item.action?.sources ?? []);
	const results = new Map<string, WebSearchResult>();
	for (const { title, url } of [...cited, ...consulted]) {
		if (!url || !/^https?:\/\//i.test(url) || results.has(url)) continue;
		results.set(url, { url, title: title || url, snippet: "" });
		if (results.size >= numResults) break;
	}
	return { answer, results: [...results.values()] };
}
