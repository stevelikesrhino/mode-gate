import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MIN_USEFUL_MARKDOWN = 80;

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function validateHttpUrl(input: string): URL | null {
	try {
		const url = new URL(input);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function isUnsupportedContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return normalized.includes("image/")
		|| normalized.includes("audio/")
		|| normalized.includes("video/")
		|| normalized.includes("application/pdf")
		|| normalized.includes("application/zip")
		|| normalized.includes("application/octet-stream");
}

function extractDocumentTitle(html: string, fallback: string): string {
	const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
	const title = titleMatch?.[1]
		?.replace(/\s+/g, " ")
		.trim();
	return title || fallback;
}

function textFromDocumentBody(html: string): string {
	const { document } = parseHTML(html);
	const body = document.body?.textContent ?? "";
	return body
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function titleFromText(text: string, fallback: string): string {
	const heading = text.match(/^#{1,2}\s+(.+)/m)?.[1]?.trim();
	return heading || fallback;
}

export async function extractContent(
	inputUrl: string,
	signal?: AbortSignal,
): Promise<ExtractedContent> {
	const parsedUrl = validateHttpUrl(inputUrl);
	if (!parsedUrl) {
		return { url: inputUrl, title: "", content: "", error: "Only HTTP(S) URLs are supported." };
	}

	const url = parsedUrl.toString();
	const fallbackTitle = parsedUrl.pathname.split("/").filter(Boolean).pop() || parsedUrl.hostname;

	try {
		const response = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/122 Safari/537.36",
				"Accept": "text/html,text/plain,application/json,application/xhtml+xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
			},
			signal: combineSignal(signal, DEFAULT_TIMEOUT_MS),
		});

		if (!response.ok) {
			return { url, title: "", content: "", error: `HTTP ${response.status}: ${response.statusText}` };
		}

		const contentType = response.headers.get("content-type") || "";
		if (isUnsupportedContentType(contentType)) {
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0] || "unknown"}`,
			};
		}

		const contentLength = response.headers.get("content-length");
		if (contentLength) {
			const bytes = Number.parseInt(contentLength, 10);
			if (Number.isFinite(bytes) && bytes > MAX_RESPONSE_BYTES) {
				return { url, title: "", content: "", error: `Response too large (${Math.round(bytes / 1024 / 1024)}MB)` };
			}
		}

		const text = await response.text();
		if (text.length > MAX_RESPONSE_BYTES) {
			return { url, title: "", content: "", error: `Response too large (${Math.round(text.length / 1024 / 1024)}MB)` };
		}

		const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml") || /^\s*<!doctype html/i.test(text) || /^\s*<html[\s>]/i.test(text);
		if (!isHtml) {
			return {
				url,
				title: titleFromText(text, fallbackTitle),
				content: text.trim(),
				error: null,
			};
		}

		const { document } = parseHTML(text);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();
		if (article?.content) {
			const markdown = turndown.turndown(article.content).trim();
			if (markdown.length >= MIN_USEFUL_MARKDOWN) {
				return {
					url,
					title: article.title || extractDocumentTitle(text, fallbackTitle),
					content: markdown,
					error: null,
				};
			}
		}

		const bodyText = textFromDocumentBody(text);
		if (!bodyText) {
			return { url, title: extractDocumentTitle(text, fallbackTitle), content: "", error: "No readable text content found." };
		}

		return {
			url,
			title: extractDocumentTitle(text, fallbackTitle),
			content: bodyText,
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const isAbort = message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout");
		return { url, title: "", content: "", error: isAbort ? "Request aborted or timed out." : message };
	}
}
