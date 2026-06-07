const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_TIMEOUT_MS = 60_000;

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface WebSearchResponse {
	answer: string;
	results: WebSearchResult[];
}

interface ExaMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: {
		code?: number;
		message?: string;
	};
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseExaMcpEnvelope(body: string): ExaMcpRpcResponse | null {
	const dataLines = body.split("\n").filter(line => line.startsWith("data:"));
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const parsed = JSON.parse(payload) as ExaMcpRpcResponse;
			if (parsed.result || parsed.error) return parsed;
		} catch {
		}
	}

	try {
		const parsed = JSON.parse(body) as ExaMcpRpcResponse;
		return parsed.result || parsed.error ? parsed : null;
	} catch {
		return null;
	}
}

async function callExaMcp(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
	const response = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: toolName, arguments: args },
		}),
		signal: combineSignal(signal, DEFAULT_TIMEOUT_MS),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Search failed (${response.status}): ${errorText.slice(0, 300)}`);
	}

	const body = await response.text();
	const parsed = parseExaMcpEnvelope(body);
	if (!parsed) throw new Error("Search returned an empty response.");

	if (parsed.error) {
		const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
		throw new Error(`Search error${code}: ${parsed.error.message || "Unknown error"}`);
	}

	if (parsed.result?.isError) {
		const message = parsed.result.content
			?.find(item => item.type === "text" && typeof item.text === "string")
			?.text
			?.trim();
		throw new Error(message || "Search returned an error.");
	}

	const text = parsed.result?.content
		?.find(item => item.type === "text" && typeof item.text === "string" && item.text.trim())
		?.text
		?.trim();
	if (!text) throw new Error("Search returned no text content.");
	return text;
}

function parseSearchResults(text: string): WebSearchResult[] {
	const blocks = text.split(/(?=^Title: )/m).filter(block => block.trim());
	const results: WebSearchResult[] = [];

	for (const block of blocks) {
		const title = block.match(/^Title: (.+)$/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL: (.+)$/m)?.[1]?.trim() ?? "";
		if (!url) continue;

		let snippet = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) {
			snippet = block.slice(textStart + 7).trim();
		} else {
			const highlightMatch = block.match(/\nHighlights:\s*\n/);
			if (highlightMatch?.index !== undefined) {
				snippet = block.slice(highlightMatch.index + highlightMatch[0].length).trim();
			}
		}
		snippet = snippet.replace(/\n---\s*$/, "").replace(/\s+/g, " ").trim();
		if (snippet.length > 500) snippet = snippet.slice(0, 497).trimEnd() + "...";

		results.push({ title: title || url, url, snippet });
	}

	return results;
}

function buildAnswer(results: WebSearchResult[]): string {
	if (results.length === 0) return "";
	return results
		.filter(result => result.snippet)
		.slice(0, 5)
		.map(result => `${result.snippet}\nSource: ${result.title} (${result.url})`)
		.join("\n\n");
}

export async function searchWeb(
	query: string,
	options: { numResults?: number; signal?: AbortSignal } = {},
): Promise<WebSearchResponse> {
	const numResults = Math.max(1, Math.min(20, Math.floor(options.numResults ?? 5)));
	const text = await callExaMcp(
		"web_search_exa",
		{
			query,
			numResults,
			livecrawl: "fallback",
			type: "auto",
			contextMaxCharacters: 3000,
		},
		options.signal,
	);

	const results = parseSearchResults(text).slice(0, numResults);
	return {
		answer: buildAnswer(results),
		results,
	};
}
