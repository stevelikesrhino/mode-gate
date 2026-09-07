/**
 * Cache-aligned compaction for non-Codex models.
 *
 * pi's native compaction serializes the conversation into a fresh prompt under
 * a different system prompt, so the summarization call gets a 100% cache miss
 * on the entire history. This extension instead reuses the exact wire payload
 * of the last live provider request (captured via before_provider_request),
 * truncates its message list at the compaction cut point, and appends a
 * summarization instruction. Retained message content stays unchanged;
 * Anthropic cache metadata may move to the retained boundary. Cache reads
 * still depend on provider-side serialization and cache availability.
 *
 * Scope:
 * - openai and openai-codex providers are excluded; their compaction is owned
 *   by other extensions or pi's native fallback.
 * - Branch summarization stays native; no tree-navigation hooks are installed.
 * - Only openai-completions and anthropic-messages payload shapes are handled;
 *   anything else falls back to pi's native compaction.
 *
 * Safety: any mismatch (no captured payload, model changed, cut point outside
 * the captured payload, tool calls in the response, truncated generation,
 * request failure) returns undefined, which makes pi run its native
 * compaction instead. A failed attempt can still add latency and cost.
 */

import { convertToLlm, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";

// Opt-in diagnostics; request bodies and authentication headers are not logged.
const DEBUG_LOG = process.env.CC_DEBUG_LOG;

function log(entry: Record<string, unknown>): void {
	if (!DEBUG_LOG) return;
	try {
		fs.appendFileSync(DEBUG_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
	} catch {
		// Never break compaction because of logging.
	}
}

// pi's native summarization prompts, verbatim, so summaries keep the same
// structured format. The tool prohibition is appended on top.
const BASE_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_INSTRUCTIONS}`;

const TOOL_PROHIBITION = `CRITICAL: Do not call any tools. Your entire response must be the summary text in the exact format above, with no explanations and no code fences.`;

const REQUEST_TIMEOUT_MS = 300_000;
const RETRY_DELAY_MS = 2_000;
const MAX_ATTEMPTS = 2;

type JsonObject = Record<string, any>;

interface CapturedRequest {
	modelKey: string;
	payload: JsonObject | undefined;
	headers: Record<string, string> | undefined;
	// Agent context messages of the same request, captured via the "context"
	// event. Used at compaction time to prove the pre-cut messages are exactly
	// a prefix of what the captured payload was built from.
	contextMessages: unknown[] | undefined;
}

const capturedBySession = new Map<string, CapturedRequest>();

function isExcludedProvider(model: { provider: string }): boolean {
	return model.provider === "openai" || model.provider === "openai-codex";
}

function modelKey(model: { provider: string; api: string; id: string }): string {
	return `${model.provider}:${model.api}:${model.id}`;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildInstruction(previousSummary: string | undefined, customInstructions: string | undefined): string {
	let text = previousSummary ? UPDATE_PROMPT : BASE_PROMPT;
	if (previousSummary) {
		text += `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>`;
	}
	if (customInstructions) {
		text += `\n\nAdditional focus: ${customInstructions}`;
	}
	text += `\n\n${TOOL_PROHIBITION}`;
	return text;
}

interface CostModel {
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
	};
}

function computeCost(model: CostModel, input: number, output: number, cacheRead: number, cacheWrite: number) {
	// Highest matching input threshold applies to the full request.
	let rates = model.cost;
	const totalInput = input + cacheRead + cacheWrite;
	if (model.cost.tiers) {
		for (const tier of model.cost.tiers) {
			if (totalInput > tier.inputTokensAbove) rates = tier;
		}
	}
	const cost = {
		input: (input * rates.input) / 1e6,
		output: (output * rates.output) / 1e6,
		cacheRead: (cacheRead * rates.cacheRead) / 1e6,
		cacheWrite: (cacheWrite * rates.cacheWrite) / 1e6,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return cost;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function postJson(url: string, body: JsonObject, headers: Record<string, string>, signal: AbortSignal): Promise<JsonObject> {
	let lastError: unknown;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) await delay(RETRY_DELAY_MS, signal);
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			if (res.ok) return (await res.json()) as JsonObject;
		} catch (err) {
			if (signal.aborted) throw err;
			lastError = err;
			continue;
		}
		const status = res.status;
		const text = await res.text().catch(() => "");
		lastError = new Error(`HTTP ${status}: ${text.slice(0, 300)}`);
		if (status !== 429 && status < 500) throw lastError;
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) return trimmed;
	const firstNewline = trimmed.indexOf("\n");
	if (firstNewline < 0) return trimmed;
	let body = trimmed.slice(firstNewline + 1);
	if (body.endsWith("```")) body = body.slice(0, -3);
	return body.trim();
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
	}
	headers[name] = value;
}

function retainAnthropicCacheBoundary(messages: JsonObject[], cutIndex: number): JsonObject[] {
	const retained = structuredClone(messages.slice(0, cutIndex));
	// Only relocate a removed explicit breakpoint; never enable caching when
	// the live request disabled it or consume another breakpoint slot.
	const removedBlocks = messages.slice(cutIndex).flatMap((message) =>
		Array.isArray(message.content) ? message.content : [],
	);
	const cacheControl = removedBlocks.findLast((block) => block?.cache_control)?.cache_control;
	if (!cacheControl) return retained;
	for (const message of [...retained].reverse()) {
		if (typeof message.content === "string" && message.content) {
			message.content = [{ type: "text", text: message.content, cache_control: structuredClone(cacheControl) }];
			break;
		}
		if (!Array.isArray(message.content)) continue;
		const block = message.content.findLast((block: JsonObject) =>
			["text", "image", "tool_use", "tool_result"].includes(block?.type),
		);
		if (block) {
			block.cache_control ??= structuredClone(cacheControl);
			break;
		}
	}
	return retained;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	for (const key of keysA) {
		if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
		if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
	}
	return true;
}

// Map only serialization shapes we can verify without rebuilding the payload.
// Unknown insertions, omissions, normalized tool IDs, and image side messages
// fall back rather than risking a cut that includes retained history.
function findWireCut(context: ReturnType<typeof convertToLlm>, messages: JsonObject[], count: number, anthropic: boolean): number | undefined {
	let wire = !anthropic && (messages[0]?.role === "system" || messages[0]?.role === "developer") ? 1 : 0;
	let cut: number | undefined;
	const pending = new Set<string>();
	for (let i = 0; i < context.length;) {
		const msg = context[i];
		const sent = messages[wire];
		if (!sent) return undefined;
		if (msg.role === "toolResult") {
			const results = [msg];
			if (anthropic) {
				while (context[i + results.length]?.role === "toolResult") results.push(context[i + results.length] as typeof msg);
			}
			if (i < count && i + results.length > count) return undefined;
			const ids = results.map((r) => r.toolCallId);
			if (results.some((r) => r.content.some((b) => b.type !== "text"))) return undefined;
			const sentIds = anthropic
				? (Array.isArray(sent.content) ? sent.content.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id) : [])
				: [sent.tool_call_id];
			if (sent.role !== (anthropic ? "user" : "tool") || !deepEqual(ids, sentIds)) return undefined;
			for (const id of ids) {
				if (!pending.delete(id)) return undefined;
			}
			i += results.length;
		} else {
			if (pending.size || sent.role !== msg.role) return undefined;
			if (msg.role === "assistant") {
				if (msg.stopReason === "error" || msg.stopReason === "aborted") return undefined;
				const ids = msg.content.filter((b) => b.type === "toolCall").map((b) => b.id);
				const sentIds = anthropic
					? (Array.isArray(sent.content) ? sent.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id) : [])
					: (sent.tool_calls ?? []).map((b: any) => b.id);
				if (!deepEqual(ids, sentIds)) return undefined;
				for (const id of ids) pending.add(id);
			}
			i++;
		}
		wire++;
		if (i === count && pending.size === 0) cut = wire;
	}
	return wire === messages.length ? cut : undefined;
}

export default function registerTextCompaction(pi: ExtensionAPI) {
	// Fires once per provider request, before convertToLlm and before the
	// payload is built: the agent context messages this request will be based
	// on. Captured so compaction can verify prefix identity.
	pi.on("context", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		capturedBySession.delete(sessionId);
		if (!ctx.model || isExcludedProvider(ctx.model) || !Array.isArray(event.messages)) return undefined;
		try {
			capturedBySession.set(sessionId, {
				modelKey: modelKey(ctx.model),
				payload: undefined,
				headers: undefined,
				contextMessages: structuredClone(event.messages),
			});
		} catch {
			log({ ev: "fallback", stage: "context-clone" });
		}
		return undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const existing = capturedBySession.get(sessionId);
		if (!ctx.model || isExcludedProvider(ctx.model) || !existing || existing.modelKey !== modelKey(ctx.model) || !isJsonObject(event.payload)) {
			capturedBySession.delete(sessionId);
			return undefined;
		}
		try {
			existing.payload = structuredClone(event.payload);
		} catch {
			capturedBySession.delete(sessionId);
			return undefined;
		}
		log({
			ev: "capture",
			session: sessionId.slice(0, 8),
			model: modelKey(ctx.model),
			msgCount: Array.isArray(event.payload.messages) ? event.payload.messages.length : -1,
		});
		return undefined;
	});

	pi.on("before_provider_headers", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const existing = capturedBySession.get(sessionId);
		if (!ctx.model || isExcludedProvider(ctx.model) || !existing || existing.modelKey !== modelKey(ctx.model)) {
			capturedBySession.delete(sessionId);
			return;
		}
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(event.headers)) {
			if (value !== null) headers[key] = value;
		}
		capturedBySession.set(sessionId, {
			modelKey: modelKey(ctx.model),
			payload: existing?.payload,
			headers,
			contextMessages: existing?.contextMessages,
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		capturedBySession.delete(ctx.sessionManager.getSessionId());
	});

	return async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		try {
			const model = ctx.model;
			if (!model) return undefined;
			// Decline before auth, preparation, or requests so other compaction
			// extensions retain ownership regardless of handler load order.
			if (isExcludedProvider(model)) return undefined;
			log({ ev: "compact-start", model: modelKey(model), reason: event.reason, willRetry: event.willRetry });
			if (model.api !== "openai-completions" && model.api !== "anthropic-messages") {
				log({ ev: "fallback", stage: "unsupported-api", api: model.api });
				return undefined;
			}

			const prep = event.preparation;
			const preCutMessages = [
				...prep.messagesToSummarize,
				...(prep.isSplitTurn ? prep.turnPrefixMessages : []),
			];
			if (convertToLlm(preCutMessages).length < 1) {
				log({ ev: "fallback", stage: "empty-preCut", msgCount: prep.messagesToSummarize.length });
				return undefined;
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const captured = capturedBySession.get(sessionId);
			if (!captured || captured.modelKey !== modelKey(model) || !captured.payload || !captured.headers) {
				log({
					ev: "fallback",
					stage: "no-capture",
					hasEntry: !!captured,
					capturedModel: captured?.modelKey,
					currentModel: modelKey(model),
				});
				return undefined;
			}

			const payload = captured.payload;
			const messages = payload.messages;
			if (!Array.isArray(messages)) {
				log({ ev: "fallback", stage: "no-messages-field" });
				return undefined;
			}

			// Verify history identity before mapping its boundary into wire messages.
			const capturedCtx = captured.contextMessages;
			if (!capturedCtx) {
				log({ ev: "fallback", stage: "no-context-capture" });
				return undefined;
			}
			if ((capturedCtx[0] as JsonObject)?.role === "compactionSummary") {
				if ((capturedCtx[0] as JsonObject).summary !== prep.previousSummary) {
					log({ ev: "fallback", stage: "previous-summary-mismatch" });
					return undefined;
				}
				preCutMessages.unshift(capturedCtx[0] as typeof preCutMessages[number]);
			} else if (prep.previousSummary !== undefined) {
				log({ ev: "fallback", stage: "missing-previous-summary" });
				return undefined;
			}
			if (capturedCtx.length < preCutMessages.length) {
				log({ ev: "fallback", stage: "context-shorter-than-precut", ctxCount: capturedCtx.length, preCutCount: preCutMessages.length });
				return undefined;
			}
			for (let i = 0; i < preCutMessages.length; i++) {
				if (!deepEqual(capturedCtx[i], preCutMessages[i])) {
					log({ ev: "fallback", stage: "context-mismatch", firstDivergence: i });
					return undefined;
				}
			}

			const isAnthropic = model.api === "anthropic-messages";
			const systemOffset = !isAnthropic && (messages[0]?.role === "system" || messages[0]?.role === "developer") ? 1 : 0;
			const preCutCount = convertToLlm(preCutMessages).length;
			const cutIndex = findWireCut(convertToLlm(capturedCtx as typeof preCutMessages), messages, preCutCount, isAnthropic);
			if (cutIndex === undefined) {
				log({ ev: "fallback", stage: "wire-boundary-mismatch", preCutCount, payloadMsgCount: messages.length });
				return undefined;
			}
			const instruction = buildInstruction(prep.previousSummary, event.customInstructions);
			const instructionMessage = isAnthropic
				? { role: "user", content: [{ type: "text", text: instruction }] }
				: { role: "user", content: instruction };

			const body: JsonObject = {
				...payload,
				messages: [...(isAnthropic ? retainAnthropicCacheBoundary(messages, cutIndex) : messages.slice(0, cutIndex)), instructionMessage],
				stream: false,
			};
			delete body.stream_options;
			// Preserve tool_choice: providers may encode it into the prompt rather
			// than treating it as a decode-only setting. Reject tool responses below.
			const toolChoice = body.tool_choice;
			if (toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none" &&
				!(isAnthropic && (toolChoice?.type === "auto" || toolChoice?.type === "none"))) {
				log({ ev: "fallback", stage: "forced-tool-choice" });
				return undefined;
			}

			// SDK clients apply apiKey authentication after the headers hook.
			// Resolve current credentials and any endpoint override for replay.
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				log({ ev: "fallback", stage: "auth-resolution", error: auth.error });
				return undefined;
			}
			const base = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "");
			const url = isAnthropic ? `${base}/v1/messages` : `${base}/chat/completions`;

			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(captured.headers)) {
				const lower = key.toLowerCase();
				if (lower === "content-length" || lower === "accept") continue;
				headers[key] = value;
			}
			if (auth.headers) {
				for (const [key, value] of Object.entries(auth.headers)) {
					if (value !== null) headers[key] = value;
				}
			}
			if (isAnthropic) {
				// before_provider_request observes SDK params, not the HTTP body.
				// The Anthropic SDK moves these fields into request headers.
				if (Array.isArray(body.betas) && !hasHeader(headers, "anthropic-beta")) {
					setHeader(headers, "anthropic-beta", body.betas.join(","));
				}
				if (body.user_profile_id != null && !hasHeader(headers, "anthropic-user-profile-id")) {
					setHeader(headers, "anthropic-user-profile-id", String(body.user_profile_id));
				}
				delete body.betas;
				delete body.user_profile_id;
			}
			if (auth.apiKey) {
				const bearer = !isAnthropic || model.provider === "github-copilot" || auth.apiKey.includes("sk-ant-oat");
				if (bearer) {
					if (isAnthropic) {
						for (const key of Object.keys(headers)) {
							if (key.toLowerCase() === "x-api-key") delete headers[key];
						}
					}
					setHeader(headers, "authorization", `Bearer ${auth.apiKey}`);
				} else setHeader(headers, "x-api-key", auth.apiKey);
			}
			// The SDK clients set these at fetch time (not in the captured event
			// headers), so they must be added explicitly.
			setHeader(headers, "content-type", "application/json");
			setHeader(headers, "accept", "application/json");
			if (isAnthropic && !hasHeader(headers, "anthropic-version")) {
				setHeader(headers, "anthropic-version", "2023-06-01");
			}

			const signal = AbortSignal.any([event.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
			log({ ev: "request", url, preCutCount, cutIndex, payloadMsgCount: messages.length, systemOffset, bodyMsgCount: body.messages.length });
			const data = await postJson(url, body, headers, signal);
			log({ ev: "raw-usage", usage: data.usage });

			let text: string;
			let usage: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				totalTokens: number;
				cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
			} | undefined;

			if (isAnthropic) {
				if (data.stop_reason !== "end_turn" && data.stop_reason !== "stop_sequence") {
					throw new Error(`summary did not finish normally: ${data.stop_reason}`);
				}
				const blocks = Array.isArray(data.content) ? data.content : [];
				if (blocks.some((b: any) => b?.type === "tool_use")) throw new Error("summary attempted to call a tool");
				text = blocks
					.filter((b: any) => b?.type === "text" && typeof b.text === "string")
					.map((b: any) => b.text)
					.join("");
				const u = data.usage;
				if (u) {
					const input = u.input_tokens ?? 0;
					const cacheRead = u.cache_read_input_tokens ?? 0;
					const cacheWrite = u.cache_creation_input_tokens ?? 0;
					const output = u.output_tokens ?? 0;
					usage = {
						input,
						output,
						cacheRead,
						cacheWrite,
						totalTokens: input + cacheRead + cacheWrite + output,
						cost: computeCost(model, input, output, cacheRead, cacheWrite),
					};
				}
			} else {
				const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
				const msg = choice?.message;
				if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
					throw new Error("summary attempted to call a tool");
				}
				if (choice?.finish_reason !== "stop" || msg?.function_call) {
					throw new Error(`summary did not finish normally: ${choice?.finish_reason}`);
				}
				const content = msg?.content;
				text =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.filter((p: any) => p?.type === "text" && typeof p.text === "string")
									.map((p: any) => p.text)
									.join("")
							: "";
				const u = data.usage;
				if (u) {
					// OpenAI reports prompt_tokens_details.cached_tokens; DeepSeek uses
					// prompt_cache_hit_tokens; some compat providers use cached_tokens.
					const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0;
					const input = Math.max(0, (u.prompt_tokens ?? 0) - cached);
					const output = u.completion_tokens ?? 0;
					usage = {
						input,
						output,
						cacheRead: cached,
						cacheWrite: 0,
						totalTokens: u.total_tokens ?? input + cached + output,
						cost: computeCost(model, input, output, cached, 0),
					};
				}
			}

			text = stripCodeFences(text);
			if (!text) throw new Error("empty summary");

			log({ ev: "compact-ok", summaryChars: text.length, usage });
			return {
				compaction: {
					summary: text,
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore,
					usage,
					details: { kind: "cache-aligned-compaction", version: 1 },
				},
			};
		} catch (err) {
			log({ ev: "fallback", stage: "error", error: err instanceof Error ? err.message : String(err) });
			try {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Cache-aligned compaction failed, falling back to native: ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					);
				}
			} catch {
				// A UI failure must not prevent native fallback.
			}
			return undefined;
		}
	};
}