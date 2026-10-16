/**
 * Cache-aligned compaction for non-Codex models.
 *
 * pi's native compaction serializes the conversation into a fresh prompt under
 * a different system prompt, preventing direct reuse of the live conversation's
 * cached prefix. This extension instead reuses the provider payload captured
 * by its before_provider_request handler (which must run after other transforms),
 * truncates its message list at the compaction cut point, and appends a
 * summarization instruction. Retained message content stays unchanged;
 * Anthropic cache metadata may move to the retained boundary. Cache reads
 * still depend on provider-side serialization and cache availability.
 *
 * Scope:
 * - Legacy openai-codex compaction remains owned by its checkpoint reader.
 * - Branch summarization stays native; tree navigation only invalidates capture.
 * - openai-completions, openai-responses, and anthropic-messages are supported;
 *   other APIs use Pi's native summary.
 *
 * Missing capture is reconstructed from projected conversation and prompt state.
 * Request-only extension transforms are not replayed during reconstruction.
 * Limit failures double retained history and retry a shorter cached prefix.
 * Unverifiable captures use saved-state reconstruction with a cost warning.
 * Failed or exhausted attempts yield to Pi's native summary for this operation.
 * Saved history and persistent settings are unchanged until a summary succeeds.
 * Failed attempts can still add latency and cost.
 */

import { buildSessionProjection, convertToLlm, findCutPoint, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionBeforeCompactResult, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isContextOverflow, type Usage } from "@earendil-works/pi-ai";
import fs from "node:fs";
import { findNativeCheckpoint } from "./codex/native-compaction.ts";
import { createTextCompaction, summaryOutputTokens, type Summary } from "./text-result.ts";

type Conversation = Parameters<typeof convertToLlm>[0];
type CompactionModel = NonNullable<ExtensionContext["model"]>;

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

// Per HTTP request, including its streamed body. Large summaries at high
// reasoning effort can exceed five minutes.
const REQUEST_TIMEOUT_MS = 900_000;
const RETRY_DELAY_MS = 2_000;
const MAX_ATTEMPTS = 2;
// Bound cache attempts independently of Pi's eventual native fallback.
const COMPACTION_TIMEOUT_MS = REQUEST_TIMEOUT_MS * MAX_ATTEMPTS;

function requestSignal(signal: AbortSignal | null | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Resolve fetch per call so test stubs of globalThis.fetch still apply.
const timedFetch: typeof globalThis.fetch = (input, init) =>
	globalThis.fetch(input, { ...init, signal: requestSignal(init?.signal) });

class CacheAlignmentError extends Error {}

class CompactionLimitError extends Error {
	constructor(message: string, readonly usage?: Usage) {
		super(message);
	}
}

function isContextLimitError(status: number, text: string, model: NonNullable<ExtensionContext["model"]>): boolean {
	if (status !== 400 && status !== 413 && status !== 422) return false;
	let message = text;
	try {
		const data: unknown = JSON.parse(text);
		const error = isJsonObject(data) ? data.error ?? data : data;
		// Exclude echoed request data; pi-ai owns all provider-specific matching.
		message = isJsonObject(error)
			? [error.message, error.code, error.type].filter((value) => typeof value === "string").join("\n")
			: typeof error === "string" ? error : "";
	} catch {
		// Some compatible endpoints return plain-text errors.
	}
	return isContextOverflow({
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "error",
		errorMessage: message.trim() || `${status} (no body)`,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	});
}

function prepareRetry(event: SessionBeforeCompactEvent, keepRecentTokens: number): SessionBeforeCompactEvent["preparation"] | undefined {
	// Feed Pi's cut selector the edited projection, not raw session entries.
	// Non-compaction entries contribute at most one conversation message;
	// preserve its source ID so the successful cut remains a real session ID.
	const entries: SessionEntry[] = buildSessionProjection(event.branchEntries).entries.flatMap(({ sourceEntry, messages }) =>
		sourceEntry.type === "compaction" ? [] : messages
			.filter((message) => message.role !== "system" && message.role !== "compactionSummary" && !isOmittedAssistant(message))
			.map((message) => ({ ...sourceEntry, type: "message" as const, message })),
	);
	if (!entries.length) return undefined;
	const cut = findCutPoint(entries, 0, entries.length, keepRecentTokens);
	const firstKeptEntryId = entries[cut.firstKeptEntryIndex]?.id;
	const conversation = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const messagesToSummarize = conversation.slice(0, historyEnd);
	const turnPrefixMessages = cut.isSplitTurn ? conversation.slice(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
	if (!firstKeptEntryId || (!messagesToSummarize.length && !turnPrefixMessages.length)) return undefined;
	return {
		...event.preparation,
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cut.isSplitTurn,
		settings: { ...event.preparation.settings, keepRecentTokens },
	};
}

function addUsage(total: Usage | undefined, next: Usage | undefined): Usage | undefined {
	if (!total) return next;
	if (!next) return total;
	return {
		input: total.input + next.input,
		output: total.output + next.output,
		cacheRead: total.cacheRead + next.cacheRead,
		cacheWrite: total.cacheWrite + next.cacheWrite,
		totalTokens: total.totalTokens + next.totalTokens,
		...(total.reasoning !== undefined || next.reasoning !== undefined
			? { reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) } : {}),
		cost: {
			input: total.cost.input + next.cost.input,
			output: total.cost.output + next.cost.output,
			cacheRead: total.cost.cacheRead + next.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
			total: total.cost.total + next.cost.total,
		},
	};
}

type JsonObject = Record<string, any>;

type PayloadCapture =
	| { state: "pending" }
	| { state: "failed" }
	| { state: "captured"; body: JsonObject };

interface CapturedRequest {
	modelKey: string;
	// Failed capture is not missing capture: only a pre-payload abort may
	// discard a valid snapshot and permit saved-state reconstruction.
	payload: PayloadCapture;
	headers?: Record<string, string>;
	contextMessages?: Conversation;
	fullContextMessages?: Conversation;
}

type ReadyCapture = CapturedRequest & {
	payload: { state: "captured"; body: JsonObject };
	headers: Record<string, string>;
	contextMessages: Conversation;
};

function isReadyCapture(captured: CapturedRequest): captured is ReadyCapture {
	return captured.payload.state === "captured" && captured.headers !== undefined && captured.contextMessages !== undefined;
}

function isExcludedProvider(model: { provider: string }): boolean {
	return model.provider === "openai-codex";
}

function modelKey(model: { provider: string; api: string; id: string }): string {
	return `${model.provider}:${model.api}:${model.id}`;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOmittedAssistant(message: unknown): boolean {
	return isJsonObject(message) && message.role === "assistant" &&
		(message.stopReason === "error" || message.stopReason === "aborted");
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

async function postJson(url: string, body: JsonObject, headers: Record<string, string>, signal: AbortSignal, model: NonNullable<ExtensionContext["model"]>): Promise<JsonObject> {
	let lastError: unknown;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) await delay(RETRY_DELAY_MS, signal);
		signal.throwIfAborted();
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: requestSignal(signal),
			});
			if (res.ok) {
				const data = await res.json();
				signal.throwIfAborted();
				return data as JsonObject;
			}
		} catch (err) {
			if (signal.aborted) throw err;
			lastError = err;
			continue;
		}
		const status = res.status;
		const text = await res.text().catch(() => "");
		signal.throwIfAborted();
		const error = new Error(`HTTP ${status}: ${text.slice(0, 300)}`);
		lastError = error;
		if (isContextLimitError(status, text, model)) throw new CompactionLimitError(error.message);
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

function setHeader(headers: Record<string, string>, name: string, value: string | null): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
	}
	if (value !== null) headers[name] = value;
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
// Unknown insertions, omissions, and image side messages fall back rather than
// risking a cut that includes retained history. Providers may normalize foreign
// tool IDs, so IDs only need a consistent one-to-one mapping within each turn.
function findWireCut(context: ReturnType<typeof convertToLlm>, messages: JsonObject[], count: number, anthropic: boolean): number | undefined {
	let wire = !anthropic && (messages[0]?.role === "system" || messages[0]?.role === "developer") ? 1 : 0;
	let cut: number | undefined;
	// Context tool call ID -> serialized ID for the open tool turn.
	const pending = new Map<string, string>();
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
			if (sent.role !== (anthropic ? "user" : "tool") || sentIds.length !== ids.length) return undefined;
			for (const [k, id] of ids.entries()) {
				if (!pending.has(id) || pending.get(id) !== sentIds[k]) return undefined;
				pending.delete(id);
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
				if (ids.length !== sentIds.length || sentIds.some((id: unknown) => typeof id !== "string") ||
					new Set(ids).size !== ids.length || new Set(sentIds).size !== sentIds.length) return undefined;
				for (const [k, id] of ids.entries()) pending.set(id, sentIds[k]);
			}
			i++;
		}
		wire++;
		if (i === count && pending.size === 0) cut = wire;
	}
	return wire === messages.length ? cut : undefined;
}

export function warnCompaction(ctx: ExtensionContext, message: string): void {
	log({ ev: "warning", message });
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
	} catch {
		// Display failures must not change compaction routing.
	}
}

function validateToolBoundary(messages: ReturnType<typeof convertToLlm>): void {
	// Validate before SDK orphan repair can invent a missing result.
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) throw new Error("unpaired tool result at summary boundary");
		} else {
			if (pending.size) throw new Error("unfinished tool turn at summary boundary");
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					if (pending.has(block.id)) throw new Error("duplicate tool call at summary boundary");
					pending.add(block.id);
				}
			}
		}
	}
	if (pending.size) throw new Error("unfinished tool turn at summary boundary");
}

async function summarizeSdk(ctx: ExtensionContext, messages: ReturnType<typeof convertToLlm>, maxTokens: number, signal: AbortSignal,
	onPayload: (generated: unknown) => JsonObject, headers?: Record<string, string>, pi?: ExtensionAPI): Promise<{ text: string; usage: Usage }> {
	const model = ctx.model!;
	validateToolBoundary(messages);
	let invalidOutput = false;
	let alignmentError: CacheAlignmentError | undefined;
	const checkOutput = (item: unknown): void => {
		if (!isJsonObject(item) || !["message", "reasoning"].includes(item.type) ||
			(item.type === "message" && Array.isArray(item.content) && item.content.some((block: any) => block?.type !== "output_text"))) invalidOutput = true;
	};
	signal.throwIfAborted();
	const thinking = pi ? ctx.thinkingLevel ?? pi.getThinkingLevel() : undefined;
	const result = await ctx.modelRegistry.streamSimple(model, { messages }, {
		signal, fetch: timedFetch, maxTokens, headers, timeoutMs: REQUEST_TIMEOUT_MS, maxRetries: MAX_ATTEMPTS - 1,
		sessionId: ctx.sessionManager.getSessionId(), transport: "sse",
		...(thinking && thinking !== "off" ? { reasoning: thinking, thinkingBudgets: pi?.getSettings().thinkingBudgets } : {}),
		onPayload: (generated) => {
			signal.throwIfAborted();
			try {
				return onPayload(generated);
			} catch (error) {
				// SDK streams normalize hook exceptions into error responses.
				if (error instanceof CacheAlignmentError) alignmentError = error;
				throw error;
			}
		},
		onProviderStreamEvent: (data) => {
			if (!isJsonObject(data)) return;
			if (typeof data.type === "string" && data.type.startsWith("response.refusal.")) invalidOutput = true;
			if (data.type === "response.output_item.added" || data.type === "response.output_item.done") checkOutput(data.item);
			if (Array.isArray(data.response?.output)) data.response.output.forEach(checkOutput);
			if (data.choices?.some((choice: any) => choice.delta?.refusal)) invalidOutput = true;
		},
	}).result();
	signal.throwIfAborted();
	log({ ev: "usage", usage: result.usage });
	if (alignmentError) throw alignmentError;
	if (invalidOutput || result.content.some((block) => block.type === "toolCall")) throw new Error("summary emitted a tool call, refusal, or unsupported output");
	if (result.stopReason === "length" || isContextOverflow(result, model.contextWindow)) {
		throw new CompactionLimitError(`summary reached limit: ${result.rawStopReason ?? result.stopReason}`, result.usage);
	}
	// The SDK owns provider-specific finish-reason normalization.
	if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `summary did not finish normally: ${result.rawStopReason ?? result.stopReason}`);
	const text = stripCodeFences(result.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
	if (!text) throw new Error("empty summary");
	return { text, usage: result.usage };
}

async function summarizeReconstructed(pi: ExtensionAPI, event: SessionBeforeCompactEvent, ctx: ExtensionContext, expected: Conversation): Promise<Summary> {
	if (findNativeCheckpoint(event.branchEntries).status !== "none") throw new Error("opaque Codex history cannot be reconstructed as text");
	const projection = buildSessionProjection(event.branchEntries);
	const boundary = projection.entries.findIndex((entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
	if (boundary < 0) throw new Error("reconstruction retained boundary is missing");
	// Project the full branch before selecting a prefix: later edits still apply.
	// Keep ALL system deltas. The cut limits conversation, not prompt/tool state.
	const prefix = projection.entries.flatMap((entry, index) => entry.messages.filter((message) =>
		!isOmittedAssistant(message) && (index < boundary || message.role === "system"),
	));
	const conversation = prefix.filter((message) => message.role !== "system" && message.role !== "compactionSummary");
	if (!deepEqual(conversation, expected)) throw new Error("reconstructed conversation does not match compaction preparation");
	const previous = prefix.filter((message) => message.role === "compactionSummary");
	if (previous.length !== (event.preparation.previousSummary === undefined ? 0 : 1) ||
		(previous[0]?.role === "compactionSummary" && previous[0].summary !== event.preparation.previousSummary)) throw new Error("reconstructed previous summary does not match");
	if (!prefix.some((message) => message.role === "system")) throw new Error("no saved system prompt for cache reconstruction");
	// A model switch need not have a live response yet. Summarize the saved
	// prompt/tool state with the selected model; do not guess unapplied prompt
	// mappings or substitute the idle prompt. Cache reuse is already best effort.
	const blockImages = pi.getSettings().images?.blockImages;
	const filtered = blockImages ? prefix.map((message) => {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
		return { ...message, content: message.content.map((block) => block.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : block)
			.filter((block, index, blocks) => !(block.type === "text" && block.text === "Image reading is disabled." && index > 0 &&
				blocks[index - 1].type === "text" && (blocks[index - 1] as { text: string }).text === block.text)) };
	}) : prefix;
	const model = ctx.model!;
	const maxTokens = summaryOutputTokens(model);
	const instruction = buildInstruction(event.preparation.previousSummary, event.customInstructions);
	return summarizeSdk(ctx, convertToLlm(filtered), maxTokens, event.signal, (generated) => {
		if (!isJsonObject(generated)) throw new Error("invalid reconstructed payload");
		const field = model.api === "openai-responses" ? "input" : "messages";
		if (!Array.isArray(generated[field]) || generated[field].length === 0) throw new Error("empty reconstructed conversation");
		const body = { ...generated, [field]: [...generated[field], { role: "user", content: model.api === "anthropic-messages" ? [{ type: "text", text: instruction }] : instruction }] };
		log({ ev: "request", mode: "reconstructed", api: model.api, bodyMsgCount: body[field].length, maxTokens });
		return body;
	}, undefined, pi);
}

async function summarizeResponses(ctx: ExtensionContext, captured: ReadyCapture, count: number, instruction: string, maxTokens: number, signal: AbortSignal): Promise<Summary> {
	const model = ctx.model!;
	const payload = captured.payload.body;
	const input = payload.input;
	const knownTypes = new Set(["message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "additional_tools", "tool_search_call", "tool_search_output"]);
	// External/opaque history cannot be proven from this local transcript.
	if (payload.previous_response_id !== undefined || payload.conversation !== undefined || payload.context_management !== undefined ||
		!Array.isArray(input) || input.some((item) => !isJsonObject(item) ||
			(item.type !== undefined ? !knownTypes.has(item.type) : !["user", "assistant", "system", "developer"].includes(item.role)))) {
		throw new CacheAlignmentError("Responses history cannot be verified for cache-aligned compaction");
	}
	if (payload.tool_choice !== undefined && payload.tool_choice !== "auto" && payload.tool_choice !== "none") {
		throw new CacheAlignmentError("summary requires an unforced tool choice");
	}
	const full = captured.fullContextMessages?.filter((message) => !isOmittedAssistant(message));
	const visible = (messages: unknown[]) => messages.filter((message) => !(isJsonObject(message) && message.role === "system"));
	if (!full || !deepEqual(visible(full), visible(captured.contextMessages.filter((message) => !isOmittedAssistant(message))))) {
		throw new CacheAlignmentError("Responses full transcript does not match the captured conversation");
	}
	const prefix: Conversation = [];
	let seen = 0;
	for (const message of full) {
		if (seen === count) break;
		prefix.push(message);
		if (!(isJsonObject(message) && message.role === "system")) seen++;
	}
	// Never summarize under an older mapped prompt just because its update is
	// beyond the conversation cut. Unknown/noncontiguous state needs a new cut,
	// not an unchecked reconstruction around the captured request.
	const systems = (messages: unknown[]) => messages.filter((message) => isJsonObject(message) && message.role === "system");
	if (!deepEqual(systems(prefix), systems(full))) throw new CacheAlignmentError("captured prefix would omit saved prompt/tool updates");
	const context = { messages: convertToLlm(prefix) };
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(captured.headers)) {
		// Current provider credentials are resolved by the registry, not replayed
		// from a potentially stale captured Authorization header.
		if (["authorization", "x-api-key", "content-length", "content-type", "accept"].includes(key.toLowerCase())) continue;
		headers[key] = value;
	}
	return summarizeSdk(ctx, context.messages, maxTokens, signal, (generated) => {
		// Use the same SDK serializer to prove the cut, then send the original
		// captured items, not the reserialized copies. Unknown transforms switch
		// to saved-state reconstruction before any HTTP request is made.
		if (!isJsonObject(generated) || !Array.isArray(generated.input) || generated.input.length === 0 ||
			!deepEqual(generated.input, input.slice(0, generated.input.length))) {
			throw new CacheAlignmentError("Responses wire prefix does not match the compaction boundary");
		}
		const body: JsonObject = { ...payload, input: [...input.slice(0, generated.input.length), { role: "user", content: instruction }], stream: true, store: false };
		// The SDK omits unsupported output caps for ChatGPT token sharing.
		// Do not restore a captured one-token cap or invent an OAuth hard limit.
		if (generated.max_output_tokens !== undefined) body.max_output_tokens = generated.max_output_tokens;
		else delete body.max_output_tokens;
		log({ ev: "request", api: model.api, cutIndex: generated.input.length, payloadMsgCount: input.length, bodyMsgCount: body.input.length, maxTokens: body.max_output_tokens });
		return body;
	}, headers);
}

function parseChatSummary(model: CompactionModel, data: JsonObject): Summary {
	const isAnthropic = model.api === "anthropic-messages";
	let text: string;
	let usage: Usage | undefined;

	if (isAnthropic) {
		if (!["end_turn", "stop_sequence", "max_tokens", "model_context_window_exceeded"].includes(data.stop_reason)) {
			throw new Error(`summary did not finish normally: ${data.stop_reason}`);
		}
		const blocks = Array.isArray(data.content) ? data.content : [];
		if (blocks.some((block: JsonObject) => block?.type === "tool_use")) throw new Error("summary attempted to call a tool");
		text = blocks.filter((block: JsonObject) => block?.type === "text" && typeof block.text === "string")
			.map((block: JsonObject) => block.text).join("");
		const u = data.usage;
		if (u) {
			const input = u.input_tokens ?? 0;
			const cacheRead = u.cache_read_input_tokens ?? 0;
			const cacheWrite = u.cache_creation_input_tokens ?? 0;
			const output = u.output_tokens ?? 0;
			usage = {
				input, output, cacheRead, cacheWrite,
				totalTokens: input + cacheRead + cacheWrite + output,
				cost: computeCost(model, input, output, cacheRead, cacheWrite),
			};
		}
	} else {
		const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
		const msg = choice?.message;
		if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) throw new Error("summary attempted to call a tool");
		if ((choice?.finish_reason !== "stop" && choice?.finish_reason !== "length") || msg?.function_call) {
			throw new Error(`summary did not finish normally: ${choice?.finish_reason}`);
		}
		const content = msg?.content;
		text = typeof content === "string" ? content : Array.isArray(content)
			? content.filter((block: JsonObject) => block?.type === "text" && typeof block.text === "string")
				.map((block: JsonObject) => block.text).join("") : "";
		const u = data.usage;
		if (u) {
			// OpenAI, DeepSeek, and compatible providers use different cache fields.
			const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0;
			const input = Math.max(0, (u.prompt_tokens ?? 0) - cached);
			const output = u.completion_tokens ?? 0;
			usage = {
				input, output, cacheRead: cached, cacheWrite: 0,
				totalTokens: u.total_tokens ?? input + cached + output,
				cost: computeCost(model, input, output, cached, 0),
			};
		}
	}

	const stopReason = isAnthropic ? data.stop_reason : data.choices?.[0]?.finish_reason;
	if (["length", "max_tokens", "model_context_window_exceeded"].includes(stopReason)) {
		throw new CompactionLimitError(`summary reached limit: ${stopReason}`, usage);
	}
	text = stripCodeFences(text);
	if (!text) throw new Error("empty summary");
	return { text, usage };
}

// Manual replay is limited to captured Chat/Anthropic requests. Keep its
// provider-specific transport and normalization out of capture/retry ownership.
async function summarizeCapturedChat(event: SessionBeforeCompactEvent, ctx: ExtensionContext,
	captured: ReadyCapture, context: Conversation, prefix: Conversation): Promise<Summary> {
	const model = ctx.model!;
	const prep = event.preparation;
	const payload = captured.payload.body;
	const messages = payload.messages;
	const isAnthropic = model.api === "anthropic-messages";
	const preCutCount = convertToLlm(prefix).length;
	const cutIndex = findWireCut(convertToLlm(context), messages, preCutCount, isAnthropic);
	if (cutIndex === undefined) throw new CacheAlignmentError("wire boundary does not match the selected prefix");
	const instruction = buildInstruction(prep.previousSummary, event.customInstructions);
	const instructionMessage = {
		role: "user",
		content: isAnthropic ? [{ type: "text", text: instruction }] : instruction,
	};
	const body: JsonObject = {
		...payload,
		messages: [...(isAnthropic ? retainAnthropicCacheBoundary(messages, cutIndex) : messages.slice(0, cutIndex)), instructionMessage],
		stream: false,
	};
	delete body.stream_options;
	// Preserve explicit thinking settings, within the model's full output limit.
	const maxTokens = summaryOutputTokens(model);
	if (!isAnthropic && body.max_completion_tokens !== undefined) {
		body.max_completion_tokens = maxTokens;
		delete body.max_tokens;
	} else {
		body.max_tokens = maxTokens;
	}
	// tool_choice can be part of the cached prompt, not just a decode setting.
	const toolChoice = body.tool_choice;
	if (toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none" &&
		!(isAnthropic && (toolChoice?.type === "auto" || toolChoice?.type === "none"))) {
		throw new CacheAlignmentError("captured request forces tool selection");
	}

	// SDK clients apply authentication after the headers hook. Resolve current
	// credentials and endpoint overrides rather than replaying captured auth.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`authentication failed: ${auth.error}`);
	const base = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "");
	const url = isAnthropic ? `${base}/v1/messages` : `${base}/chat/completions`;
	const headers: Record<string, string> = {};
	const ownsAuth = !!auth.apiKey || Object.keys(auth.headers ?? {}).some((key) =>
		["authorization", "x-api-key"].includes(key.toLowerCase()),
	);
	for (const [key, value] of Object.entries(captured.headers)) {
		const lower = key.toLowerCase();
		if (lower === "content-length" || lower === "accept") continue;
		// Keep hook-owned authentication only when the resolver does not own it.
		if (ownsAuth && (lower === "authorization" || lower === "x-api-key")) continue;
		setHeader(headers, key, value);
	}
	for (const [key, value] of Object.entries(auth.headers ?? {})) {
		setHeader(headers, key, value);
	}
	if (isAnthropic) {
		// The capture observes SDK params; these fields become HTTP headers.
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
		setHeader(headers, bearer ? "x-api-key" : "authorization", null);
		setHeader(headers, bearer ? "authorization" : "x-api-key", bearer ? `Bearer ${auth.apiKey}` : auth.apiKey);
	}
	setHeader(headers, "content-type", "application/json");
	setHeader(headers, "accept", "application/json");
	if (isAnthropic && !hasHeader(headers, "anthropic-version")) {
		setHeader(headers, "anthropic-version", "2023-06-01");
	}

	log({ ev: "request", url, preCutCount, cutIndex, payloadMsgCount: messages.length, bodyMsgCount: body.messages.length, maxTokens, keepRecentTokens: prep.settings.keepRecentTokens });
	const data = await postJson(url, body, headers, event.signal, model);
	log({ ev: "raw-usage", usage: data.usage });
	return parseChatSummary(model, data);
}

export default function registerTextCompaction(pi: ExtensionAPI) {
	const capturedBySession = new Map<string, CapturedRequest>();

	// Fires once per provider request, before convertToLlm and before the
	// payload is built: the agent context messages this request will be based
	// on. Captured so compaction can verify prefix identity.
	pi.on("context", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		capturedBySession.delete(sessionId);
		if (!ctx.model || isExcludedProvider(ctx.model)) return undefined;
		const captured: CapturedRequest = { modelKey: modelKey(ctx.model), payload: { state: "pending" } };
		capturedBySession.set(sessionId, captured);
		try {
			if (Array.isArray(event.messages)) captured.contextMessages = structuredClone(event.messages);
		} catch {
			log({ ev: "capture-error", stage: "context-clone" });
		}
		return undefined;
	});

	pi.on("context_with_system", (event, ctx) => {
		const existing = capturedBySession.get(ctx.sessionManager.getSessionId());
		if (!ctx.model || !existing || existing.modelKey !== modelKey(ctx.model)) return;
		try {
			existing.fullContextMessages = structuredClone(event.messages);
		} catch {
			existing.fullContextMessages = undefined;
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const existing = capturedBySession.get(sessionId);
		if (!ctx.model || isExcludedProvider(ctx.model) || !existing || existing.modelKey !== modelKey(ctx.model)) {
			capturedBySession.delete(sessionId);
			return undefined;
		}
		// Clear any older payload before capturing this request.
		existing.payload = { state: "failed" };
		if (!isJsonObject(event.payload)) return undefined;
		try {
			existing.payload = { state: "captured", body: structuredClone(event.payload) };
		} catch {
			return undefined;
		}
		log({
			ev: "capture",
			session: sessionId.slice(0, 8),
			model: modelKey(ctx.model),
			msgCount: Array.isArray(event.payload.messages ?? event.payload.input) ? (event.payload.messages ?? event.payload.input).length : -1,
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
		existing.headers = headers;
	});

	const clearCapture = (_event: unknown, ctx: ExtensionContext): void => {
		capturedBySession.delete(ctx.sessionManager.getSessionId());
	};
	pi.on("session_start", clearCapture);
	pi.on("session_compact", clearCapture);
	pi.on("session_tree", clearCapture);
	pi.on("session_shutdown", clearCapture);

	const attempt = async (event: SessionBeforeCompactEvent, ctx: ExtensionContext, reconstruct: boolean) => {
		event.signal.throwIfAborted();
		const model = ctx.model;
		if (!model || isExcludedProvider(model)) throw new Error("no supported text-compaction model selected");
		log({ ev: "compact-start", model: modelKey(model), reason: event.reason, willRetry: event.willRetry });
		if (model.api !== "openai-completions" && model.api !== "openai-responses" && model.api !== "anthropic-messages") {
			throw new Error(`unsupported cache API: ${model.api}`);
		}

		const prep = event.preparation;
		const preCutMessages = [
			...prep.messagesToSummarize,
			...(prep.isSplitTurn ? prep.turnPrefixMessages : []),
		].filter((message) => !isOmittedAssistant(message));
		if (convertToLlm(preCutMessages).length < 1) throw new Error("no conversation to summarize");

		if (reconstruct) {
			log({ ev: "reconstruct", model: modelKey(model) });
			const summary = await summarizeReconstructed(pi, event, ctx, preCutMessages);
			return { compaction: createTextCompaction(prep, model, summary) };
		}
		const captured = capturedBySession.get(ctx.sessionManager.getSessionId());
		if (!captured || captured.modelKey !== modelKey(model)) throw new CacheAlignmentError("no matching live capture");
		if (!isReadyCapture(captured)) throw new CacheAlignmentError("incomplete live request capture");

		const payload = captured.payload.body;
		const messages = model.api === "openai-responses" ? payload.input : payload.messages;
		if (!Array.isArray(messages)) throw new CacheAlignmentError("captured request has no conversation field");
		// Reconstruction applies current image policy instead of replaying blocked images.
		if (pi.getSettings().images?.blockImages && messages.some((item) =>
			[item?.content, item?.output].some((blocks) => Array.isArray(blocks) && blocks.some((block) =>
				["input_image", "image", "image_url"].includes(block?.type))))) {
			throw new CacheAlignmentError("captured request contains currently blocked images");
		}

		// Only reuse a captured prefix that matches Pi's projected preparation.
		const capturedCtx = captured.contextMessages.filter((message) =>
			!isOmittedAssistant(message) && message.role !== "system",
		);
		if (capturedCtx[0]?.role === "compactionSummary") {
			if (capturedCtx[0].summary !== prep.previousSummary) throw new CacheAlignmentError("captured previous summary differs from preparation");
			preCutMessages.unshift(capturedCtx[0]);
		} else if (prep.previousSummary !== undefined) {
			throw new CacheAlignmentError("captured previous summary is missing");
		}
		if (capturedCtx.length < preCutMessages.length) throw new CacheAlignmentError("captured history is shorter than the selected prefix");
		for (let i = 0; i < preCutMessages.length; i++) {
			if (!deepEqual(capturedCtx[i], preCutMessages[i])) throw new CacheAlignmentError(`captured history differs at message ${i}`);
		}

		const summary = model.api === "openai-responses"
			? await summarizeResponses(ctx, captured, preCutMessages.length, buildInstruction(prep.previousSummary, event.customInstructions), summaryOutputTokens(model), event.signal)
			: await summarizeCapturedChat(event, ctx, captured, capturedCtx, preCutMessages);
		return { compaction: createTextCompaction(prep, model, summary) };
	};

	return async (event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<SessionBeforeCompactResult> => {
		let current = event;
		let usage: Usage | undefined;
		// Local to this compaction: the next operation always tries capture again.
		let reconstruct = false;
		const signal = AbortSignal.any([event.signal, AbortSignal.timeout(COMPACTION_TIMEOUT_MS)]);
		for (;;) {
			try {
				const result = await attempt({ ...current, signal }, ctx, reconstruct);
				result.compaction.usage = addUsage(usage, result.compaction.usage);
				log({ ev: "compact-ok", summaryChars: result.compaction.summary.length, usage: result.compaction.usage });
				return result;
			} catch (err) {
				signal.throwIfAborted();
				if (err instanceof CacheAlignmentError && !reconstruct) {
					reconstruct = true;
					warnCompaction(ctx, "Rebuilding the compaction request from saved state. Cache reuse is uncertain; this may cost more.");
					log({ ev: "cache-miss", reason: err.message });
					continue;
				}
				if (!(err instanceof CompactionLimitError)) throw err;
				usage = addUsage(usage, err.usage);
				let next: ReturnType<typeof prepareRetry> = undefined;
				let keepRecentTokens = current.preparation.settings.keepRecentTokens;
				// Skip repeated cuts: only send another request when the prefix shrinks.
				do {
					keepRecentTokens = keepRecentTokens > 0 ? keepRecentTokens * 2 : 8192;
					if (!Number.isSafeInteger(keepRecentTokens)) break;
					next = prepareRetry(current, keepRecentTokens);
				} while (next && next.firstKeptEntryId === current.preparation.firstKeptEntryId);
				const previousIndex = event.branchEntries.findIndex((entry) => entry.id === current.preparation.firstKeptEntryId);
				const nextIndex = next ? event.branchEntries.findIndex((entry) => entry.id === next.firstKeptEntryId) : -1;
				if (!next || nextIndex < 0 || nextIndex >= previousIndex) {
					log({ ev: "limit-exhausted", error: err.message, usage });
					throw new Error(`cached backoff exhausted: ${err.message}`);
				}
				log({ ev: "limit-retry", keepRecentTokens: next.settings.keepRecentTokens, firstKeptEntryId: next.firstKeptEntryId, usage: err.usage });
				try {
					if (ctx.hasUI) ctx.ui.notify(`Retrying cached compaction with ${next.settings.keepRecentTokens} recent tokens retained.`, "info");
				} catch {
					// Progress display must not affect compaction.
				}
				current = { ...event, preparation: next };
			}
		}
	};
}
