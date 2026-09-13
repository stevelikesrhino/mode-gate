// Smoke test for the cache-compaction extension.
// Loads the extension through jiti with the same aliases pi's loader uses,
// registers fake handlers, and exercises the capture + compaction logic
// against a stubbed fetch. No provider calls are made.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PI_ROOT = process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(path.join(PI_ROOT, "node_modules/jiti/lib/jiti-static.mjs"));
const { transformMessages } = await import(path.join(PI_ROOT, "node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js"));

const jiti = createJiti(path.join(PI_ROOT, "dist/index.js"), {
	alias: {
		"@earendil-works/pi-coding-agent": path.join(PI_ROOT, "dist/index.js"),
	},
	moduleCache: false,
});

const factory = await jiti.import(fileURLToPath(new URL("../text-compaction.ts", import.meta.url)), { default: true });

// ---- fake pi ------------------------------------------------------------
const handlers = {};
const pi = {
	on: (name, fn) => {
		(handlers[name] ??= []).push(fn);
	},
	registerTool: () => {},
	registerCommand: () => {},
	registerFlag: () => {},
	onShutdown: () => {},
};
pi.on("session_before_compact", factory(pi));

const must = (cond, label) => {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		process.exitCode = 1;
	} else {
		console.log(`ok: ${label}`);
	}
};

must(Array.isArray(handlers.context) && handlers.context.length === 1, "registered context");
must(Array.isArray(handlers.before_provider_request) && handlers.before_provider_request.length === 1, "registered before_provider_request");
must(Array.isArray(handlers.before_provider_headers) && handlers.before_provider_headers.length === 1, "registered before_provider_headers");
must(Array.isArray(handlers.session_before_compact) && handlers.session_before_compact.length === 1, "registered session_before_compact");

// ---- stubbed fetch -------------------------------------------------------
const fetchCalls = [];
let responseQueue = [];
globalThis.fetch = async (url, init) => {
	fetchCalls.push({ url, init });
	const next = responseQueue.shift();
	if (!next) throw new Error("no stubbed response queued");
	return next();
};

const okJson = (obj) => () => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const bad = (status, body) => () => ({ ok: false, status, json: async () => ({}), text: async () => body });

// ---- fakes ---------------------------------------------------------------
const SESSION = "s1";
const model = {
	provider: "zhipu",
	api: "openai-completions",
	id: "glm-5.1",
	name: "GLM 5.1",
	input: ["text"],
	baseUrl: "https://api.z.ai",
	contextWindow: 200000,
	maxTokens: 8192,
	reasoning: false,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.125 },
};
const ctx = {
	model,
	sessionManager: { getSessionId: () => SESSION },
	hasUI: false,
	ui: {},
	modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "resolved-key" }) },
};

const userMsg = { role: "user", content: "hi", timestamp: 1 };
const assistantMsg = {
	role: "assistant",
	content: [{ type: "text", text: "hello" }],
	api: "openai-completions",
	provider: "zhipu",
	model: "glm-5.1",
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	errorMessage: "",
	timestamp: 2,
};
const userNextCtx = { role: "user", content: "next", timestamp: 3 };

const openaiPayload = {
	model: "glm-5.1",
	messages: [
		{ role: "system", content: "SYS" },
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "hello" },
		{ role: "user", content: "next" },
	],
	tools: [{ type: "function", function: { name: "bash", description: "d", parameters: {} } }],
	stream: true,
	stream_options: { include_usage: true },
	temperature: 1,
};

function compactEvent(overrides = {}) {
	const { preparation: prepOverrides, ...rest } = overrides;
	return {
		preparation: {
			firstKeptEntryId: "e5",
			messagesToSummarize: [userMsg, assistantMsg],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1234,
			fileOps: {},
			settings: { reserveTokens: 15000, keepRecentTokens: 16000 },
			...prepOverrides,
		},
		branchEntries: [],
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		...rest,
	};
}

// Fires the per-request events in the order pi emits them:
// context -> before_provider_headers -> before_provider_request.
function capture(ctxArg, { payload = openaiPayload, contextMessages = [userMsg, assistantMsg, userNextCtx], fireContext = true } = {}) {
	if (fireContext) for (const fn of handlers.context) fn({ messages: structuredClone(contextMessages) }, ctxArg);
	for (const fn of handlers.before_provider_headers)
		fn(
			{
				headers: {
					authorization: "Bearer test",
					"content-type": "application/json",
					accept: "text/event-stream",
					"x-null": null,
				},
			},
			ctxArg,
		);
	for (const fn of handlers.before_provider_request) fn({ payload: structuredClone(payload) }, ctxArg);
}

async function captureOpenai(opts) {
	capture(ctx, opts);
}

// ---- A: OpenAI-compatible happy path -------------------------------------
await captureOpenai();
responseQueue = [
	okJson({
		choices: [{ message: { role: "assistant", content: "## Goal\ntest" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 90 } },
	}),
];
let result = await handlers.session_before_compact[0](compactEvent(), ctx);
must(fetchCalls.length === 1, "A: one fetch call");
must(fetchCalls[0]?.url === "https://api.z.ai/chat/completions", "A: url is baseUrl + /chat/completions");
let body = JSON.parse(fetchCalls[0]?.init.body ?? "{}");
must(body.messages.length === 4, "A: truncated to system + 2 pre-cut + instruction");
must(body.messages[0].role === "system" && body.messages[0].content === "SYS", "A: system message preserved verbatim");
must(body.messages[1].content === "hi" && body.messages[2].content === "hello", "A: pre-cut messages preserved verbatim");
must(typeof body.messages[3].content === "string" && body.messages[3].content.includes("conversation to summarize"), "A: instruction appended as string user message");
must(body.messages[3].content.includes("Do not call any tools"), "A: tool prohibition present");
must(!Object.hasOwn(body, "tool_choice"), "A: absent tool_choice stays absent");
must(body.stream === false && body.stream_options === undefined, "A: stream disabled, stream_options removed");
must(body.tools?.length === 1, "A: tools kept in payload");
must(body.temperature === 1 && body.model === "glm-5.1", "A: other payload fields untouched");
const reqHeaders = fetchCalls[0]?.init.headers ?? {};
must(reqHeaders.authorization === "Bearer resolved-key", "A: auth header from resolved apiKey (not captured headers)");
must(reqHeaders["content-type"] === "application/json", "A: content-type set explicitly");
must(reqHeaders.accept === "application/json", "A: accept reset to application/json");
must(reqHeaders["content-length"] === undefined, "A: content-length dropped");
must(reqHeaders["x-null"] === undefined, "A: null header dropped");
must(result?.compaction?.summary === "## Goal\ntest", "A: summary returned");
must(result?.compaction?.firstKeptEntryId === "e5" && result?.compaction?.tokensBefore === 1234, "A: firstKeptEntryId/tokensBefore passed through");
must(result?.compaction?.details?.kind === "cache-aligned-compaction", "A: details kind set");
const u = result?.compaction?.usage;
must(u?.input === 10 && u?.cacheRead === 90 && u?.output === 50 && u?.totalTokens === 150, "A: usage mapped (cached split out)");
must(Math.abs(u?.cost.cacheRead - 90 * 0.1 / 1e6) < 1e-12 && Math.abs(u?.cost.input - 10 * 1 / 1e6) < 1e-12, "A: cost computed from model rates");

// ---- B: Codex guard --------------------------------------------------------
fetchCalls.length = 0;
responseQueue = [okJson({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] })];
const codexCtx = { ...ctx, model: { ...model, provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-luna" } };
result = await handlers.session_before_compact[0](compactEvent(), codexCtx);
must(result === undefined, "B: Codex model returns undefined");
must(fetchCalls.length === 0, "B: no fetch for Codex model");

// ---- C: tool call in response -> fallback ----------------------------------
await captureOpenai();
responseQueue = [
	okJson({
		choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
	}),
];
result = await handlers.session_before_compact[0](compactEvent(), ctx);
must(result === undefined, "C: tool call in response falls back to native");

// ---- D: Anthropic happy path ------------------------------------------------
fetchCalls.length = 0;
const anthropicModel = {
	provider: "anthropic",
	api: "anthropic-messages",
	id: "claude-x",
	name: "Claude X",
	input: ["text"],
	baseUrl: "https://api.anthropic.com",
	contextWindow: 200000,
	maxTokens: 8192,
	reasoning: false,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const anthropicCtx = { ...ctx, model: anthropicModel };
const anthropicPayload = {
	model: "claude-x",
	system: "SYS",
	messages: [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
		{ role: "user", content: "next" },
	],
	tools: [{ name: "bash", description: "d", input_schema: {} }],
	max_tokens: 4096,
	stream: true,
};
capture(anthropicCtx, { payload: anthropicPayload });
responseQueue = [
	okJson({
		id: "msg_1",
		type: "message",
		content: [{ type: "text", text: "## Goal\nanthropic" }],
		stop_reason: "end_turn",
		usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 80, cache_creation_input_tokens: 3 },
	}),
];
result = await handlers.session_before_compact[0](compactEvent(), anthropicCtx);
must(fetchCalls[0]?.url === "https://api.anthropic.com/v1/messages", "D: url is baseUrl + /v1/messages");
body = JSON.parse(fetchCalls[0]?.init.body ?? "{}");
must(body.system === "SYS", "D: top-level system preserved");
must(body.messages.length === 3, "D: truncated to 2 pre-cut + instruction");
must(Array.isArray(body.messages[2].content) && body.messages[2].content[0].type === "text", "D: instruction is a text block");
must(body.tool_choice === undefined, "D: no tool_choice for Anthropic");
must(body.max_tokens === 8192, "D: independent summary budget capped by model limit");
const dHeaders = fetchCalls[0]?.init.headers ?? {};
must(dHeaders["x-api-key"] === "resolved-key", "D: x-api-key from resolved apiKey");
must(dHeaders["anthropic-version"] === "2023-06-01", "D: anthropic-version set");
must(dHeaders["content-type"] === "application/json", "D: content-type set");
const customVerCtx = { ...anthropicCtx, sessionManager: { getSessionId: () => "s-customver" } };
capture(customVerCtx, { payload: anthropicPayload });
responseQueue = [okJson({ content: [{ type: "text", text: "v" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })];
// simulate a captured anthropic-version by pre-firing the headers event with one
for (const fn of handlers.before_provider_headers) fn({ headers: { "anthropic-version": "custom-2099-01-01", "x-api-key": "k" } }, customVerCtx);
await handlers.session_before_compact[0](compactEvent(), customVerCtx);
const cvHeaders = fetchCalls.at(-1)?.init.headers ?? {};
must(cvHeaders["anthropic-version"] === "custom-2099-01-01", "D: captured anthropic-version not overwritten");
must(result?.compaction?.summary === "## Goal\nanthropic", "D: summary returned");
const du = result?.compaction?.usage;
must(du?.input === 5 && du?.cacheRead === 80 && du?.cacheWrite === 3 && du?.output === 7 && du?.totalTokens === 95, "D: usage mapped");

// ---- E: no captured payload -> fallback -------------------------------------
result = await handlers.session_before_compact[0](compactEvent(), { ...ctx, sessionManager: { getSessionId: () => "s-missing" } });
must(result === undefined, "E: no capture falls back to native");

// ---- F: cut point beyond captured payload -> fallback -----------------------
fetchCalls.length = 0;
const shortCtx = { ...ctx, sessionManager: { getSessionId: () => "s-short" } };
capture(shortCtx, { payload: { model: "glm-5.1", messages: [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }] } });
responseQueue = [okJson({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] })];
result = await handlers.session_before_compact[0](compactEvent(), shortCtx);
must(result === undefined, "F: cut beyond payload falls back to native");
must(fetchCalls.length === 0, "F: no fetch sent");

// ---- G: 429 then success -> retry --------------------------------------------
await captureOpenai();
responseQueue = [
	bad(429, "rate limited"),
	okJson({ choices: [{ message: { content: "## Goal\nretried" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
];
result = await handlers.session_before_compact[0](compactEvent(), ctx);
must(result?.compaction?.summary === "## Goal\nretried", "G: 429 retried once then succeeds");
must(fetchCalls.length === 2, "G: exactly two fetch attempts");

// ---- H: finish_reason length -> fallback --------------------------------------
await captureOpenai();
responseQueue = [okJson({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] })];
result = await handlers.session_before_compact[0](compactEvent(), ctx);
must(result === undefined, "H: truncated generation falls back to native");

// ---- I: update path with pi's actual leading summary context -------------------
const previousContext = { role: "compactionSummary", summary: "## Goal\nold", tokensBefore: 5000, timestamp: 0 };
await captureOpenai({
	contextMessages: [previousContext, userMsg, assistantMsg, userNextCtx],
	payload: { ...openaiPayload, messages: [openaiPayload.messages[0], { role: "user", content: "Previous summary" }, ...openaiPayload.messages.slice(1)] },
});
responseQueue = [okJson({ choices: [{ message: { content: "## Goal\nupdated" }, finish_reason: "stop" }] })];
result = await handlers.session_before_compact[0](
	compactEvent({ preparation: { previousSummary: "## Goal\nold" }, customInstructions: "focus on files" }),
	ctx,
);
body = JSON.parse(fetchCalls.at(-1)?.init.body ?? "{}");
const instr = body.messages.at(-1).content;
must(instr.includes("NEW conversation messages"), "I: update prompt used when previousSummary present");
must(instr.includes("<previous-summary>\n## Goal\nold\n</previous-summary>"), "I: previous summary embedded");
must(instr.includes("Additional focus: focus on files"), "I: custom instructions appended");
must(result?.compaction?.summary === "## Goal\nupdated", "I: update result returned");

// ---- J: code fences stripped ----------------------------------------------------
await captureOpenai();
responseQueue = [okJson({ choices: [{ message: { content: "```markdown\n## Goal\nfenced\n```" }, finish_reason: "stop" }] })];
result = await handlers.session_before_compact[0](compactEvent(), ctx);
must(result?.compaction?.summary === "## Goal\nfenced", "J: code fences stripped");

// ---- K: auth resolution failure -> fallback -------------------------------------
fetchCalls.length = 0;
await captureOpenai();
responseQueue = [okJson({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] })];
const noAuthCtx = { ...ctx, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } };
result = await handlers.session_before_compact[0](compactEvent(), noAuthCtx);
must(result === undefined, "K: auth failure falls back to native");
must(fetchCalls.length === 0, "K: no fetch on auth failure");

// ---- L: auth baseUrl override ----------------------------------------------------
fetchCalls.length = 0;
await captureOpenai();
responseQueue = [okJson({ choices: [{ message: { content: "## Goal\nproxied" }, finish_reason: "stop" }] })];
const proxyCtx = { ...ctx, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "resolved-key", baseUrl: "https://proxy.example.com/deepseek/" }) } };
result = await handlers.session_before_compact[0](compactEvent(), proxyCtx);
must(fetchCalls[0]?.url === "https://proxy.example.com/deepseek/chat/completions", "L: auth baseUrl override used, trailing slash normalized");
must(result?.compaction?.summary === "## Goal\nproxied", "L: proxied result returned");

// ---- M: context mismatch -> fallback ---------------------------------------------
// Same counts, different content: identity check must reject.
fetchCalls.length = 0;
const mismatchCtx = { ...ctx, sessionManager: { getSessionId: () => "s-mismatch" } };
capture(mismatchCtx, { contextMessages: [{ role: "user", content: "DIFFERENT", timestamp: 1 }, assistantMsg, userNextCtx] });
responseQueue = [okJson({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] })];
result = await handlers.session_before_compact[0](compactEvent(), mismatchCtx);
must(result === undefined, "M: diverged context falls back to native");
must(fetchCalls.length === 0, "M: no fetch on context mismatch");

// ---- N: no context capture -> fallback --------------------------------------------
fetchCalls.length = 0;
const noCtxCtx = { ...ctx, sessionManager: { getSessionId: () => "s-noctx" } };
capture(noCtxCtx, { fireContext: false });
responseQueue = [okJson({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] })];
result = await handlers.session_before_compact[0](compactEvent(), noCtxCtx);
must(result === undefined, "N: missing context capture falls back to native");
must(fetchCalls.length === 0, "N: no fetch without context capture");

// ---- O: cut lands exactly at the end of the captured payload -> success ------------
// When only the final assistant reply is retained, the pre-cut set equals the
// whole captured payload. Appending the instruction preserves the full prefix;
// whether the provider reuses its cache is outside this stubbed test's scope.
fetchCalls.length = 0;
const edgeCtx = { ...ctx, sessionManager: { getSessionId: () => "s-edge" } };
capture(edgeCtx, {
	payload: {
		model: "glm-5.1",
		messages: [
			{ role: "system", content: "SYS" },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		],
		tools: [{ type: "function", function: { name: "bash", description: "d", parameters: {} } }],
		stream: true,
	},
	contextMessages: [userMsg, assistantMsg],
});
responseQueue = [
	okJson({
		choices: [{ message: { role: "assistant", content: "## Goal\nedge" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 990 } },
	}),
];
result = await handlers.session_before_compact[0](compactEvent(), edgeCtx);
must(fetchCalls.length === 1, "O: fetch sent when cut == payload end");
body = JSON.parse(fetchCalls[0]?.init.body ?? "{}");
must(body.messages.length === 4, "O: full payload + instruction");
must(body.messages[0].content === "SYS" && body.messages[1].content === "hi" && body.messages[2].content === "hello", "O: entire captured payload preserved verbatim");
must(typeof body.messages[3].content === "string" && body.messages[3].content.includes("conversation to summarize"), "O: instruction appended after the full payload");
must(result?.compaction?.summary === "## Goal\nedge", "O: edge-case summary returned");

// ---- P: DeepSeek-style usage fields ----------------------------------------------
// DeepSeek reports cached tokens as prompt_cache_hit_tokens, not
// prompt_tokens_details.cached_tokens.
fetchCalls.length = 0;
const dsCtx = { ...ctx, sessionManager: { getSessionId: () => "s-ds" } };
capture(dsCtx);
responseQueue = [
	okJson({
		choices: [{ message: { role: "assistant", content: "## Goal\nds" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 40000, completion_tokens: 100, prompt_cache_hit_tokens: 39500, prompt_cache_miss_tokens: 500, total_tokens: 40100 },
	}),
];
result = await handlers.session_before_compact[0](compactEvent(), dsCtx);
const pu = result?.compaction?.usage;
must(pu?.cacheRead === 39500, "P: prompt_cache_hit_tokens parsed as cacheRead");
must(pu?.input === 500, "P: non-cached input = prompt_tokens - cache hits");
must(pu?.totalTokens === 40100, "P: totalTokens from response");
must(Math.abs(pu?.cost.cacheRead - 39500 * 0.1 / 1e6) < 1e-12, "P: cacheRead cost at cache rate");
must(Math.abs(pu?.cost.input - 500 * 1 / 1e6) < 1e-12, "P: input cost at full rate");

// Tool selection must not change the provider's prompt prefix.
for (const toolChoice of ["auto", "none"]) {
	await captureOpenai({ payload: { ...openaiPayload, tool_choice: toolChoice } });
	responseQueue = [okJson({ choices: [{ message: { content: "summary" }, finish_reason: "stop" }] })];
	result = await handlers.session_before_compact[0](compactEvent(), ctx);
	body = JSON.parse(fetchCalls.at(-1).init.body);
	must(body.tool_choice === toolChoice, `Q: preserves tool_choice=${toolChoice}`);
	const { messages, stream, stream_options, ...originalFields } = { ...openaiPayload, tool_choice: toolChoice };
	const { messages: sentMessages, stream: sentStream, max_tokens: summaryMaxTokens, ...sentFields } = body;
	must(summaryMaxTokens === 8192, `Q: independent summary budget (${toolChoice})`);
	must(JSON.stringify(sentFields) === JSON.stringify(originalFields), `Q: fields other than transport and output budget preserved (${toolChoice})`);
	must(JSON.stringify(sentMessages.slice(0, -1)) === JSON.stringify(messages.slice(0, 3)), `Q: exact message prefix preserved (${toolChoice})`);
}
for (const toolChoice of ["required", { type: "function", function: { name: "bash" } }]) {
	await captureOpenai({ payload: { ...openaiPayload, tool_choice: toolChoice } });
	fetchCalls.length = 0;
	result = await handlers.session_before_compact[0](compactEvent(), ctx);
	must(result === undefined && fetchCalls.length === 0, "Q: forced tool choice falls back without a request");
}

// Grouped Anthropic tool results must map to one wire message, not two.
const toolAssistant = { ...assistantMsg, content: [
	{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
	{ type: "toolCall", id: "t2", name: "bash", arguments: {} },
], stopReason: "toolUse" };
const toolResults = ["t1", "t2"].map((id) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: id }], isError: false, timestamp: 3 }));
const groupedContext = [userMsg, toolAssistant, ...toolResults, assistantMsg, userNextCtx];
const groupedPayload = { ...anthropicPayload, messages: [
	{ role: "user", content: "hi" },
	{ role: "assistant", content: ["t1", "t2"].map((id) => ({ type: "tool_use", id, name: "bash", input: {} })) },
	{ role: "user", content: ["t1", "t2"].map((id) => ({ type: "tool_result", tool_use_id: id, content: id })) },
	{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	{ role: "user", content: "next" },
] };
capture(anthropicCtx, { contextMessages: groupedContext, payload: groupedPayload });
responseQueue = [okJson({ content: [{ type: "text", text: "grouped summary" }], stop_reason: "end_turn" })];
result = await handlers.session_before_compact[0](compactEvent({ preparation: { messagesToSummarize: [], isSplitTurn: true, turnPrefixMessages: groupedContext.slice(0, 4) } }), anthropicCtx);
body = JSON.parse(fetchCalls.at(-1).init.body);
must(result?.compaction?.summary === "grouped summary", "R: grouped tool results summarized");
must(body.messages.length === 4 && JSON.stringify(body.messages.slice(0, -1)) === JSON.stringify(groupedPayload.messages.slice(0, 3)), "R: grouped wire cut excludes retained assistant");
must(result?.compaction?.firstKeptEntryId === "e5", "R: native retained-tail boundary unchanged");

// A new context without a new payload must never reuse the old wire history.
await captureOpenai();
handlers.context[0]({ messages: [userMsg, assistantMsg, userNextCtx] }, ctx);
fetchCalls.length = 0;
result = await handlers.session_before_compact[0](compactEvent(), ctx);
must(result === undefined && fetchCalls.length === 0, "S: interrupted request invalidates stale payload");
await captureOpenai();
handlers.before_provider_request[0]({ payload: null }, ctx);
result = await handlers.session_before_compact[0](compactEvent(), ctx);
must(result === undefined && fetchCalls.length === 0, "S: invalid payload clears old capture");

await captureOpenai();
result = await handlers.session_before_compact[0](compactEvent({ preparation: { previousSummary: "missing" } }), ctx);
must(result === undefined && fetchCalls.length === 0, "T: missing prior summary falls back");
await captureOpenai({ contextMessages: [previousContext, userMsg, assistantMsg, userNextCtx] });
result = await handlers.session_before_compact[0](compactEvent({ preparation: { previousSummary: "wrong" } }), ctx);
must(result === undefined && fetchCalls.length === 0, "T: divergent prior summary falls back");

await captureOpenai({ payload: { ...openaiPayload, messages: [...openaiPayload.messages.slice(0, 2), { role: "assistant", content: "synthetic bridge" }, ...openaiPayload.messages.slice(2)] } });
result = await handlers.session_before_compact[0](compactEvent(), ctx);
must(result === undefined && fetchCalls.length === 0, "U: unexpected wire insertion falls back");
result = await handlers.session_before_compact[0](compactEvent({ preparation: { messagesToSummarize: null } }), ctx);
must(result === undefined, "U: preparation exceptions return native fallback");

await captureOpenai();
fetchCalls.length = 0;
responseQueue = [bad(401, "unauthorized")];
result = await handlers.session_before_compact[0](compactEvent(), ctx);
must(result === undefined && fetchCalls.length === 1, "V: permanent HTTP failure falls back without retry");
for (const finish of ["content_filter", "tool_calls", undefined]) {
	responseQueue = [okJson({ choices: [{ message: { content: "not a valid summary" }, finish_reason: finish }] })];
	result = await handlers.session_before_compact[0](compactEvent(), ctx);
	must(result === undefined, `V: rejects non-success finish ${finish}`);
}

// Provider ownership is keyed by provider, not by the wire API shape.
for (const provider of ["openai", "openai-codex"]) {
	for (const api of ["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages"]) {
		let authCalls = 0;
		const excludedCtx = {
			...ctx,
			model: { ...model, provider, api },
			modelRegistry: { getApiKeyAndHeaders: async () => { authCalls++; throw new Error("must not resolve auth"); } },
		};
		capture(excludedCtx);
		fetchCalls.length = 0;
		let preparationReads = 0;
		result = await handlers.session_before_compact[0]({ get preparation() { preparationReads++; throw new Error("must not prepare"); } }, excludedCtx);
		must(result === undefined && !authCalls && !fetchCalls.length && !preparationReads, `W: ${provider}/${api} yields ownership without side effects`);
	}
}

// Even a provider switch without a context event must discard stale capture.
for (const hook of ["before_provider_headers", "before_provider_request"]) {
	await captureOpenai();
	const excludedCtx = { ...ctx, model: { ...model, provider: "openai" } };
	handlers[hook][0]({ payload: openaiPayload, headers: {} }, excludedCtx);
	fetchCalls.length = 0;
	result = await handlers.session_before_compact[0](compactEvent(), ctx);
	must(result === undefined && fetchCalls.length === 0, `W: ${hook} invalidates capture on excluded provider switch`);
}

// Native branch summarization owns the tree hooks; observation is read-only.
must(!handlers.session_before_tree && !handlers.session_tree, "X: no branch-summary or tree-navigation handlers");
for (const [name, event] of [
	["context", { messages: [userMsg, assistantMsg, userNextCtx] }],
	["before_provider_headers", { headers: { authorization: "Bearer original", accept: "text/event-stream" } }],
	["before_provider_request", { payload: openaiPayload }],
]) {
	const input = structuredClone(event);
	const original = structuredClone(input);
	const returned = handlers[name][0](input, ctx);
	must(returned === undefined && JSON.stringify(input) === JSON.stringify(original), `X: ${name} leaves native request data unchanged`);
}

// SDK params carry beta flags separately from actual HTTP headers.
const realisticAnthropic = {
	...anthropicPayload,
	betas: ["interleaved-thinking-2025-05-14"],
	user_profile_id: "test-profile",
	messages: anthropicPayload.messages.map((message, index) => index === 2
		? { ...message, content: [{ type: "text", text: "next", cache_control: { type: "ephemeral", ttl: "1h" } }] }
		: message),
};
for (const [provider, key, bearer] of [
	["anthropic", "ordinary-key", false],
	["anthropic", "sk-ant-oat-test", true],
	["github-copilot", "copilot-test", true],
]) {
	const current = { ...anthropicCtx, model: { ...anthropicModel, provider }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: key }) } };
	capture(current, { payload: realisticAnthropic });
	responseQueue = [okJson({ content: [{ type: "text", text: "summary" }], stop_reason: "end_turn" })];
	result = await handlers.session_before_compact[0](compactEvent(), current);
	must(result?.compaction?.summary === "summary", `Y: ${provider} summary succeeds`);
	const call = fetchCalls.at(-1);
	const sent = JSON.parse(call.init.body);
	must(!Object.hasOwn(sent, "betas") && !Object.hasOwn(sent, "user_profile_id"), "Y: SDK-only params removed");
	must(call.init.headers["anthropic-beta"] === realisticAnthropic.betas[0], "Y: beta flags moved to header");
	must(call.init.headers["anthropic-user-profile-id"] === "test-profile", "Y: profile moved to header");
	must(sent.messages[1].content[0].cache_control?.ttl === "1h", "Y: dropped breakpoint relocated with TTL");
	must(!sent.messages.at(-1).content[0].cache_control, "Y: no cache write breakpoint on one-off instruction");
	must(!realisticAnthropic.messages[1].content[0].cache_control, "Y: original payload remains unchanged");
	must(bearer ? call.init.headers.authorization === `Bearer ${key}` && !call.init.headers["x-api-key"] : call.init.headers["x-api-key"] === key, `Y: ${provider} uses correct auth scheme`);
}

// Failed assistants are omitted from wire history, not deleted from saved history.
const failedAssistant = { ...assistantMsg, content: [], stopReason: "error", errorMessage: "fetch failed" };
const abortedAssistant = { ...assistantMsg, stopReason: "aborted", content: [
	{ type: "thinking", thinking: "Unfinished thought" },
	{ type: "text", text: "Unfinished answer" },
	{ type: "toolCall", id: "partial-call", name: "bash", arguments: {} },
] };
const lengthAssistant = { ...assistantMsg, stopReason: "length" };
const failedToolResult = { ...toolResults[0], isError: true, content: [{ type: "text", text: "Important tool failure" }] };
const orphanResult = { ...failedToolResult, toolCallId: "partial-call" };
const u0 = userMsg, a0 = assistantMsg, tail = userNextCtx, err = failedAssistant, aborted = abortedAssistant;

// Apply pi's actual omission/orphan-repair rules, then encode these text/tool fixtures.
function historyWire(messages, currentModel) {
	const anthropic = currentModel.api === "anthropic-messages";
	const wire = anthropic ? [] : [openaiPayload.messages[0]];
	for (const message of transformMessages(messages, currentModel)) {
		if (message.role === "user") {
			wire.push({ role: "user", content: message.content });
		} else if (message.role === "assistant") {
			const calls = message.content.filter(block => block.type === "toolCall");
			const text = message.content.filter(block => block.type === "text").map(block => block.text).join("");
			wire.push(anthropic
				? { role: "assistant", content: [
					...(text ? [{ type: "text", text }] : []),
					...calls.map(call => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
				] }
				: { role: "assistant", content: text, ...(calls.length ? { tool_calls: calls.map(call => ({
					type: "function", id: call.id, function: { name: call.name, arguments: JSON.stringify(call.arguments) },
				})) } : {}) });
		} else {
			assert.equal(message.role, "toolResult");
			const text = message.content.map(block => block.text).join("");
			if (anthropic) {
				const block = { type: "tool_result", tool_use_id: message.toolCallId, content: text, is_error: message.isError };
				if (wire.at(-1)?.content?.[0]?.type === "tool_result") wire.at(-1).content.push(block);
				else wire.push({ role: "user", content: [block] });
			} else wire.push({ role: "tool", tool_call_id: message.toolCallId, content: text });
		}
	}
	return wire;
}

for (const currentModel of [model, anthropicModel]) {
	for (const test of [
		{ name: "error in retained tail", prefix: [u0, a0], context: [u0, a0, err, tail] },
		{ name: "saved error absent from active context", prefix: [u0, err, a0], context: [u0, a0, tail] },
		{ name: "error present on both sides", prefix: [u0, err, a0], context: [u0, err, a0, tail] },
		{ name: "partial aborted response", prefix: [u0, aborted, a0], context: [u0, aborted, a0, tail] },
		{ name: "multiple failures at cut", prefix: [u0, a0, err, aborted], context: [u0, a0, err, aborted, tail] },
		{ name: "leading failures", prefix: [err, aborted, u0, a0], context: [err, aborted, u0, a0, tail] },
		{ name: "split turn with failures", prefix: [u0, err, a0], context: [u0, err, a0, aborted, tail], split: true },
		{ name: "tool error preserved", prefix: [u0, toolAssistant, failedToolResult, toolResults[1], a0], context: [u0, toolAssistant, failedToolResult, toolResults[1], err, a0, tail], text: "Important tool failure" },
		{ name: "length assistant preserved", prefix: [u0, lengthAssistant], context: [u0, lengthAssistant, tail], text: "hello" },
		{ name: "missing length assistant", prefix: [u0, lengthAssistant, a0], context: [u0, a0, tail], fallback: true },
		{ name: "real content mismatch", prefix: [u0, err, { ...a0, content: [{ type: "text", text: "DIFFERENT" }] }], context: [u0, err, a0, tail], fallback: true },
		{ name: "orphan result after aborted call", prefix: [u0, aborted, orphanResult], context: [u0, aborted, orphanResult, tail], fallback: true },
		{ name: "synthetic missing tool results", prefix: [u0, toolAssistant, a0], context: [u0, toolAssistant, err, a0, tail], fallback: true },
		{ name: "only failures to summarize", prefix: [err, aborted], context: [err, aborted, tail], fallback: true },
	]) {
		const label = `Z: ${currentModel.api}: ${test.name}`;
		const current = { ...ctx, model: currentModel, sessionManager: { getSessionId: () => label } };
		const anthropic = currentModel.api === "anthropic-messages";
		const payload = { ...(anthropic ? anthropicPayload : openaiPayload), messages: historyWire(test.context, currentModel) };
		const event = compactEvent({ preparation: {
			messagesToSummarize: test.split ? [] : test.prefix,
			turnPrefixMessages: test.split ? test.prefix : [],
			isSplitTurn: !!test.split,
		} });
		const original = structuredClone({ context: test.context, payload, preparation: event.preparation });
		capture(current, { payload, contextMessages: test.context });
		fetchCalls.length = 0;
		responseQueue = [okJson(anthropic
			? { content: [{ type: "text", text: "Summary" }], stop_reason: "end_turn" }
			: { choices: [{ message: { content: "Summary" }, finish_reason: "stop" }] })];
		result = await handlers.session_before_compact[0](event, current);
		assert.deepEqual({ context: test.context, payload, preparation: event.preparation }, original, `${label}: inputs unchanged`);
		if (test.fallback) {
			assert.equal(result, undefined, label);
			assert.equal(fetchCalls.length, 0, `${label}: no request`);
		} else {
			assert.equal(result?.compaction?.summary, "Summary", label);
			assert.equal(fetchCalls.length, 1, label);
			assert.equal(result.compaction.firstKeptEntryId, event.preparation.firstKeptEntryId, label);
			const sent = JSON.parse(fetchCalls[0].init.body);
			const expected = historyWire(test.prefix, currentModel);
			assert.deepEqual(sent.messages.slice(0, -1), expected, `${label}: expected wire prefix`);
			assert.deepEqual(sent.messages.slice(0, -1), payload.messages.slice(0, expected.length), `${label}: captured prefix unchanged`);
			if (test.text) assert.ok(JSON.stringify(sent.messages.slice(0, -1)).includes(test.text), label);
		}
		console.log(`ok: ${label}`);
	}
}

// Summary output must not inherit a live request's overflow-clamped cap.
for (const [name, fields, maxTokens, reserveTokens, keepRecentTokens, expected] of [
	["one-token live cap", { max_tokens: 1 }, 64000, 15000, 16000, 16000],
	["completion-token field", { max_completion_tokens: 1 }, 64000, 15000, 16000, 16000],
	["conflicting output fields", { max_tokens: 1, max_completion_tokens: 1 }, 64000, 15000, 16000, 16000],
	["model output ceiling", { max_tokens: 1 }, 8192, 15000, 16000, 8192],
	["zero reserve", { max_tokens: 1 }, 64000, 0, 16000, 16000],
	["reserve wins", { max_tokens: 1 }, 64000, 24000, 16000, 24000],
	["minimum budget", { max_tokens: 1 }, 64000, 0, 0, 8192],
]) {
	const label = `AA: ${name}`;
	const current = { ...ctx, model: { ...model, maxTokens }, sessionManager: { getSessionId: () => label } };
	const payload = { ...openaiPayload, ...fields };
	const original = structuredClone(payload);
	capture(current, { payload });
	fetchCalls.length = 0;
	responseQueue = [okJson({ choices: [{ message: { content: "Summary" }, finish_reason: "stop" }] })];
	const event = compactEvent({ reason: "overflow", willRetry: true, preparation: { settings: { reserveTokens, keepRecentTokens } } });
	result = await handlers.session_before_compact[0](event, current);
	assert.equal(result?.compaction?.summary, "Summary", label);
	assert.equal(fetchCalls.length, 1, label);
	const sent = JSON.parse(fetchCalls[0].init.body);
	assert.equal(sent.max_completion_tokens ?? sent.max_tokens, expected, label);
	if (fields.max_completion_tokens !== undefined) assert.equal(sent.max_tokens, undefined, label);
	assert.deepEqual(sent.messages.slice(0, -1), payload.messages.slice(0, 3), label);
	assert.deepEqual(sent.tools, payload.tools, label);
	assert.equal(result.compaction.firstKeptEntryId, event.preparation.firstKeptEntryId, label);
	assert.deepEqual(payload, original, `${label}: original cap unchanged`);
	console.log(`ok: ${label}`);
}

for (const [maxTokens, expected] of [[64000, 32000], [20000, 20000]]) {
	const label = `AB: Anthropic thinking with model cap ${maxTokens}`;
	const current = { ...anthropicCtx, model: { ...anthropicModel, maxTokens }, sessionManager: { getSessionId: () => label } };
	const payload = { ...anthropicPayload, max_tokens: 60000, thinking: { type: "enabled", budget_tokens: 16000 } };
	const original = structuredClone(payload);
	capture(current, { payload });
	fetchCalls.length = 0;
	responseQueue = [okJson({ content: [{ type: "text", text: "Summary" }], stop_reason: "end_turn" })];
	const event = compactEvent();
	result = await handlers.session_before_compact[0](event, current);
	assert.equal(result?.compaction?.summary, "Summary", label);
	assert.equal(fetchCalls.length, 1, label);
	const sent = JSON.parse(fetchCalls[0].init.body);
	assert.equal(sent.max_tokens, expected, label);
	assert.ok(sent.max_tokens > sent.thinking.budget_tokens, label);
	assert.deepEqual(sent.thinking, payload.thinking, label);
	assert.deepEqual(sent.messages.slice(0, -1), payload.messages.slice(0, 2), label);
	assert.deepEqual(sent.tools, payload.tools, label);
	assert.equal(result.compaction.firstKeptEntryId, event.preparation.firstKeptEntryId, label);
	assert.deepEqual(payload, original, `${label}: original budget unchanged`);
	console.log(`ok: ${label}`);
}

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");
