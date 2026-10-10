// Offline contracts owned by this extension, not a provider integration matrix.
// Optional real-session/serializer coverage lives in responses-cache-e2e.mjs.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(path.join(root, "node_modules/jiti/lib/jiti-static.mjs"));
const jiti = createJiti(path.join(root, "dist/index.js"), {
	alias: Object.fromEntries(["pi-coding-agent", "pi-ai"].map(name => [
		`@earendil-works/${name}`,
		name === "pi-coding-agent" ? path.join(root, "dist/index.js") : path.join(root, "node_modules/@earendil-works", name, "dist/index.js"),
	])),
	moduleCache: false, fsCache: false,
});
const register = await jiti.import(fileURLToPath(new URL("../text-compaction.ts", import.meta.url)), { default: true });
const { prepareCompaction } = await import(path.join(root, "dist/core/compaction/compaction.js"));
const { streamSimple: responsesStream } = await import(path.join(root, "node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js"));
const usage = { input: 10, output: 20, cacheRead: 90, cacheWrite: 0, totalTokens: 120,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const tools = [{ type: "function", function: { name: "fixture", description: "Saved tool", parameters: { type: "object", properties: {} } } }];
const entry = (message, index) => ({ type: "message", id: `e${index}`, parentId: index ? `e${index - 1}` : null,
	timestamp: new Date(index).toISOString(), message });
let session = 0;

function fixture(t, api = "openai-completions") {
	const handlers = {};
	const state = { settings: {}, auth: { ok: true, apiKey: "fresh-key" }, http: [], sdk: [], responses: [] };
	const model = { provider: api === "anthropic-messages" ? "anthropic" : "openai", api, id: "fixture",
		baseUrl: "https://fixture.invalid", contextWindow: 200000, maxTokens: 64000, input: ["text", "image"], reasoning: false,
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.125 } };
	const user = { role: "user", content: "Remember this", timestamp: 1 };
	const assistant = { role: "assistant", content: [{ type: "text", text: "Remembered" }], api, provider: model.provider,
		model: model.id, stopReason: "stop", usage, timestamp: 2 };
	const tail = { role: "user", content: "Retained conversation", timestamp: 3 };
	const system = { role: "system", content: "Saved prompt", toolsAdded: [{ name: "fixture", description: "Saved tool", parameters: { type: "object", properties: {} } }], timestamp: 0 };
	const messages = [user, assistant, tail];
	const branch = [system, ...messages].map(entry);
	const id = `unit-${++session}`;
	const ctx = { model, hasUI: false, thinkingLevel: "off", sessionManager: { getSessionId: () => id, getBranch: () => branch },
		modelRegistry: {
			getApiKeyAndHeaders: async () => state.auth,
			// Unit seam: verify reconstruction forwards the right transcript and owns
			// its instruction. Provider serialization is deliberately not reimplemented.
			streamSimple: (current, context, options) => ({ result: async () => {
				const body = options.onPayload({ messages: context.messages });
				state.sdk.push({ context, options, body });
				return { ...assistant, content: [{ type: "text", text: "Summary" }], rawStopReason: current.api === "anthropic-messages" ? "end_turn" : "stop" };
			} }),
		} };
	const compact = register({ on: (name, fn) => (handlers[name] ??= []).push(fn),
		getSettings: () => state.settings, getThinkingLevel: () => "off" });
	const emit = async (name, event) => { for (const fn of handlers[name] ?? []) await fn(event, ctx); };
	const event = { preparation: { firstKeptEntryId: "e3", messagesToSummarize: [user, assistant], turnPrefixMessages: [],
		isSplitTurn: false, tokensBefore: 50000, settings: { enabled: true, reserveTokens: 1024, keepRecentTokens: 8192 } },
		branchEntries: branch, signal: new AbortController().signal, reason: "manual", willRetry: false };
	const wire = history => history.map(message => ({ role: message.role,
		content: typeof message.content === "string" ? message.content : message.content.map(block => block.text).join("") }));
	const payload = { model: model.id, messages: wire(messages), tools, stream: true, stream_options: { include_usage: true }, max_tokens: 1 };
	if (api === "anthropic-messages") payload.system = "Saved prompt";
	else payload.messages.unshift({ role: "system", content: "Saved prompt" });
	const capture = async (body = payload, history = messages) => {
		await emit("context", { messages: history });
		await emit("context_with_system", { messages: [system, ...history] });
		await emit("before_provider_headers", { headers: { Authorization: "Bearer stale", "X-Api-Key": "stale-key", "X-Keep": "extension",
			"X-Remove": "stale", "x-rotate": "stale", "content-length": "999", accept: "text/event-stream" } });
		await emit("before_provider_request", { payload: body });
	};
	const success = (reason = "stop") => api === "anthropic-messages"
		? { content: [{ type: "text", text: "Summary" }], stop_reason: reason === "stop" ? "end_turn" : reason,
			usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 20 } }
		: { choices: [{ message: { content: "Summary" }, finish_reason: reason }],
			usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 90, completion_tokens: 20 } };
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		state.http.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) });
		assert.ok(state.responses.length, "Unexpected HTTP request (network is never allowed)");
		const response = state.responses.shift();
		return response instanceof Response ? response : Response.json(response);
	};
	t.after(() => { globalThis.fetch = originalFetch; });
	return { ...state, state, ctx, handlers, emit, event, branch, system, user, assistant, tail, messages, payload, wire, capture, success,
		run: (current = event) => compact(current, ctx) };
}

for (const api of ["openai-completions", "anthropic-messages"]) {
	test(`${api}: exact prefix, tools, output budget, cache usage, immutable history`, async t => {
		const f = fixture(t, api);
		if (api === "anthropic-messages") {
			f.payload.betas = ["fixture-beta"];
			f.payload.messages.at(-1).content = [{ type: "text", text: f.tail.content, cache_control: { type: "ephemeral", ttl: "1h" } }];
		}
		const before = structuredClone({ payload: f.payload, branch: f.branch });
		await f.capture();
		f.responses.push(f.success());
		const result = await f.run();
		assert.equal(result.compaction.summary, "Summary");
		assert.equal(result.compaction.firstKeptEntryId, "e3");
		assert.equal(result.compaction.usage.cacheRead, 90);
		assert.equal(result.compaction.usage.input, 10);
		assert.equal(result.compaction.details.budget.keepRecentTokens, 8192);
		assert.equal(f.http.length, 1);
		const { body, headers } = f.http[0];
		assert.deepEqual(body.tools, tools);
		assert.equal(body.max_tokens, 8192);
		assert.equal(body.stream, false);
		assert.equal(body.stream_options, undefined);
		assert.equal(headers.get("content-length"), null);
		assert.equal(headers.get("accept"), "application/json");
		if (api === "anthropic-messages") {
			assert.equal(body.messages[1].content[0].text, "Remembered");
			assert.deepEqual(body.messages[1].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
			assert.equal(headers.get("anthropic-beta"), "fixture-beta");
			assert.equal(body.betas, undefined);
			assert.match(body.messages.at(-1).content[0].text, /Do not call any tools/);
		} else {
			assert.deepEqual(body.messages.slice(0, -1), f.payload.messages.slice(0, -1));
			assert.match(body.messages.at(-1).content, /Do not call any tools/);
		}
		assert.deepEqual({ payload: f.payload, branch: f.branch }, before);
	});
}

for (const [name, api, auth, expected, provider] of [
	["Chat bearer", "openai-completions", { apiKey: "fresh" }, ["Bearer fresh", null]],
	["Anthropic key", "anthropic-messages", { apiKey: "fresh" }, [null, "fresh"]],
	["Anthropic OAuth", "anthropic-messages", { apiKey: "sk-ant-oat-fresh" }, ["Bearer sk-ant-oat-fresh", null]],
	["Copilot bearer", "anthropic-messages", { apiKey: "fresh" }, ["Bearer fresh", null], "github-copilot"],
	["header-owned auth", "anthropic-messages", { headers: { authorization: "Bearer current" } }, ["Bearer current", null]],
	["explicit auth removal", "anthropic-messages", { headers: { AUTHORIZATION: null } }, [null, null]],
	["hook-owned auth", "anthropic-messages", {}, ["Bearer stale", "stale-key"]],
]) {
	test(`headers: ${name}, case-insensitive replacement and null deletion`, async t => {
		const f = fixture(t, api);
		if (provider) f.ctx.model.provider = provider;
		f.state.auth = { ok: true, ...auth, headers: { "x-remove": null, "X-Rotate": "fresh", ...auth.headers } };
		await f.capture();
		f.responses.push(f.success());
		assert.ok((await f.run()).compaction);
		const headers = f.http[0].headers;
		assert.deepEqual([headers.get("authorization"), headers.get("x-api-key")], expected);
		assert.equal(headers.get("x-remove"), null);
		assert.equal(headers.get("x-rotate"), "fresh", "must not combine stale and current values");
		assert.equal(headers.get("x-keep"), "extension");
	});
}

test("output budgets preserve Anthropic thinking and respect model caps", async t => {
	const f = fixture(t, "anthropic-messages");
	f.payload.thinking = { type: "enabled", budget_tokens: 2048 };
	f.ctx.model.maxTokens = 10000;
	await f.capture();
	f.responses.push(f.success());
	assert.ok((await f.run()).compaction);
	assert.equal(f.http[0].body.max_tokens, 10000);
	assert.deepEqual(f.http[0].body.thinking, f.payload.thinking);
});

test("Chat completion caps replace the live cap without sending both cap fields", async t => {
	const f = fixture(t);
	f.payload.max_completion_tokens = 1;
	f.ctx.model.maxTokens = 4096;
	await f.capture();
	f.responses.push(f.success());
	assert.ok((await f.run()).compaction);
	assert.equal(f.http[0].body.max_completion_tokens, 4096);
	assert.equal(f.http[0].body.max_tokens, undefined);
});

test("invalid capture, divergence, tool choice, image policy, and abort fail before HTTP", async t => {
	const f = fixture(t);
	for (const change of [
		() => f.emit("before_provider_request", { payload: null }),
		() => { f.event.preparation.messagesToSummarize = [{ ...f.user, content: "different" }, f.assistant]; },
		() => f.emit("before_provider_request", { payload: { ...f.payload, tool_choice: "required" } }),
		() => { f.state.settings = { images: { blockImages: true } }; return f.emit("before_provider_request", { payload: { ...f.payload,
			messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "fixture" } }] }] } }); },
		() => { f.event.signal = AbortSignal.abort(); },
	]) {
		f.state.settings = {};
		f.event.signal = new AbortController().signal;
		f.event.preparation.messagesToSummarize = [f.user, f.assistant];
		await f.capture();
		await change();
		assert.deepEqual(await f.run(), { cancel: true });
	}
	assert.equal(f.http.length, 0);
	assert.equal(f.sdk.length, 0, "invalid capture never becomes reconstruction");
});

test("tool IDs may normalize, but the cut cannot contain an unfinished tool turn", async t => {
	const f = fixture(t);
	const call = { ...f.assistant, stopReason: "toolUse", content: [{ type: "toolCall", id: "foreign|id", name: "fixture", arguments: {} }] };
	const result = { role: "toolResult", toolCallId: "foreign|id", toolName: "fixture", content: [{ type: "text", text: "Done" }], isError: false, timestamp: 3 };
	const payload = { ...f.payload, messages: [f.payload.messages[0], { role: "user", content: f.user.content },
		{ role: "assistant", content: null, tool_calls: [{ id: "normalized", type: "function", function: { name: "fixture", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "normalized", content: "Done" }, { role: "user", content: f.tail.content }] };
	await f.capture(payload, [f.user, call, result, f.tail]);
	f.event.preparation.messagesToSummarize = [f.user, call, result];
	f.responses.push(f.success());
	assert.ok((await f.run()).compaction);
	assert.deepEqual(f.http[0].body.messages.slice(0, -1), payload.messages.slice(0, -1));
	f.event.preparation.messagesToSummarize = [f.user, call];
	assert.deepEqual(await f.run(), { cancel: true });
	assert.equal(f.http.length, 1);
});

test("HTTP errors, tool output, empty text, and truncated summaries never create a checkpoint", async t => {
	const f = fixture(t);
	await f.capture();
	for (const response of [
		new Response("unauthorized", { status: 401 }),
		{ choices: [{ message: { content: "Not a summary", tool_calls: [{ id: "call" }] }, finish_reason: "stop" }] },
		{ choices: [{ message: { content: "" }, finish_reason: "stop" }] },
		f.success("length"),
	]) {
		f.responses.push(response);
		assert.deepEqual(await f.run(), { cancel: true });
	}
	assert.equal(f.http.length, 4);
});

test("limit recovery moves the cut earlier, adds usage, and stops for exhausted or edited history", async t => {
	const f = fixture(t);
	const messages = Array.from({ length: 48 }, (_, i) => i % 2
		? { ...f.assistant, content: [{ type: "text", text: "y".repeat(4000) }], timestamp: i }
		: { ...f.user, content: "x".repeat(4000), timestamp: i });
	const branch = messages.map(entry);
	const settings = f.event.preparation.settings;
	const preparation = prepareCompaction(branch, settings);
	const event = { ...f.event, branchEntries: branch, preparation };
	await f.capture({ ...f.payload, messages: [f.payload.messages[0], ...f.wire(messages)] }, messages);
	for (const failure of [f.success("length"), new Response('{"error":{"code":"context_length_exceeded","message":"Maximum context length exceeded"}}', { status: 400 })]) {
		f.http.length = 0;
		f.responses.push(failure, f.success());
		const result = await f.run(event);
		assert.equal(result.compaction.firstKeptEntryId, prepareCompaction(branch, { ...settings, keepRecentTokens: 16384 }).firstKeptEntryId);
		assert.equal(result.compaction.usage.output, failure instanceof Response ? 20 : 40);
		assert.equal(result.compaction.details.budget.keepRecentTokens, 16384, "metadata uses the successful retry's budget");
		assert.deepEqual(f.http.map(call => call.body.max_tokens), [8192, 16384]);
		const [first, second] = f.http.map(call => call.body.messages);
		assert.ok(second.length < first.length);
		assert.deepEqual(second.slice(0, -1), first.slice(0, second.length - 1));
	}
	f.http.length = 0;
	f.responses.push(...Array.from({ length: 5 }, () => f.success("length")));
	assert.deepEqual(await f.run({ ...event, preparation: prepareCompaction(branch, { ...settings, keepRecentTokens: 1024 }) }), { cancel: true });
	assert.equal(f.http.length, 5, "at most four limit retries");
	f.http.length = 0;
	f.responses.push(f.success("length"));
	assert.deepEqual(await f.run({ ...event, branchEntries: [...branch, { type: "context_edit" }] }), { cancel: true });
	assert.equal(f.http.length, 1, "never select a raw-entry retry cut around edits");
});

for (const [name, mode, reconstruct] of [
	["DeepSeek reports Esc as error", "abort", true],
	["explicit aborted assistant", "assistant-abort", true],
	["payload hook failed", "invalid-payload", false],
	["payload observed without headers", "no-headers", false],
	["context cloning failed", "clone-failed", false],
	["full context missing", "no-full", false],
	["not aborted", "active", false],
]) {
	test(`capture lifecycle: ${name}`, async t => {
		const f = fixture(t);
		await f.emit("context", { messages: mode === "clone-failed" ? [() => {}] : f.messages });
		if (mode !== "no-full") await f.emit("context_with_system", { messages: [f.system, ...f.messages] });
		if (mode === "invalid-payload" || mode === "no-headers") await f.emit("before_provider_request", { payload: mode === "invalid-payload" ? null : f.payload });
		if (mode !== "active" && mode !== "assistant-abort") f.ctx.signal = AbortSignal.abort();
		await f.emit("agent_end", { messages: [{ ...f.assistant, stopReason: mode === "assistant-abort" ? "aborted" : "error" }] });
		const result = await f.run();
		assert.equal(!!result.compaction, reconstruct);
		assert.equal(f.sdk.length, reconstruct ? 1 : 0);
		assert.equal(f.http.length, 0);
	});
}

test("complete capture survives Esc; session start, tree change, and shutdown invalidate it", async t => {
	const f = fixture(t);
	await f.capture();
	f.ctx.signal = AbortSignal.abort();
	await f.emit("agent_end", { messages: [{ ...f.assistant, stopReason: "error" }] });
	f.responses.push(f.success());
	assert.ok((await f.run()).compaction);
	assert.equal(f.http.length, 1);
	assert.equal(f.sdk.length, 0);
	for (const name of ["session_start", "session_tree", "session_shutdown"]) {
		await f.capture();
		await f.emit(name, {});
		assert.ok((await f.run()).compaction);
	}
	assert.equal(f.sdk.length, 3);
	assert.equal(f.http.length, 1);
	assert.equal(f.handlers.session_before_tree, undefined, "Pi still owns branch summarization");
});

test("capture belongs to its registration, even when runtimes share a session ID", async t => {
	const f = fixture(t);
	await f.capture();
	const handlers = {};
	const other = register({ on: (name, fn) => (handlers[name] ??= []).push(fn), getSettings: () => ({}), getThinkingLevel: () => "off" });
	assert.ok((await other(f.event, f.ctx)).compaction);
	assert.equal(f.sdk.length, 1, "another runtime must reconstruct rather than borrow capture");
	for (const fn of handlers.session_start) await fn({}, f.ctx);
	f.responses.push(f.success());
	assert.ok((await f.run()).compaction);
	assert.equal(f.http.length, 1, "another runtime cannot invalidate our capture");
});

test("reconstruction uses edited history and saved prompt/tools, including later prompt deltas", async t => {
	const f = fixture(t);
	const replacement = { ...f.user, content: "Edited before compaction" };
	f.branch.push(entry({ ...f.system, content: "Latest mapped prompt", timestamp: 4 }, 4),
		{ type: "context_edit", id: "edit", parentId: "e4", timestamp: new Date(5).toISOString(), targetId: "e1", replacement: { content: replacement.content } });
	f.event.preparation.messagesToSummarize = [replacement, f.assistant];
	const original = structuredClone(f.branch);
	assert.ok((await f.run()).compaction);
	const { context, body } = f.sdk[0];
	assert.ok(context.messages.some(message => message.role === "user" && message.content === replacement.content));
	assert.ok(context.messages.some(message => message.role === "system" && message.content === "Latest mapped prompt"));
	assert.deepEqual(context.messages[0].toolsAdded, f.system.toolsAdded);
	assert.ok(!context.messages.some(message => message.content === f.tail.content));
	assert.match(body.messages.at(-1).content, /Do not call any tools/);
	assert.deepEqual(f.branch, original);
	f.branch.push({ type: "model_change", id: "switch", parentId: "edit", timestamp: new Date(6).toISOString(), provider: f.ctx.model.provider, modelId: f.ctx.model.id });
	assert.deepEqual(await f.run(), { cancel: true }, "unapplied model switch must not guess prompt state");
	assert.equal(f.sdk.length, 1);
});

test("Responses serializer proves the captured prefix; unsupported output or divergent wire cancels", async t => {
	const f = fixture(t, "openai-responses");
	f.ctx.modelRegistry.streamSimple = (model, context, options) => responsesStream(model, context, { ...options, apiKey: "sk-offline-fixture" });
	let payload;
	await responsesStream(f.ctx.model, { messages: [f.system, ...f.messages] }, { apiKey: "sk-offline-fixture", maxRetries: 0,
		onPayload: value => { payload = structuredClone(value); throw new Error("serialize only; no HTTP"); },
	}).result();
	assert.ok(payload);
	assert.equal(f.http.length, 0);
	await f.capture(payload);
	const response = (extra = []) => {
		const item = { type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Summary", annotations: [] }] };
		return new Response([
			{ type: "response.created", response: { id: "resp" } }, ...extra,
			{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Summary" },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 90 } } } },
		].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	};
	f.responses.push(response());
	assert.ok((await f.run()).compaction);
	const body = f.http[0].body;
	assert.deepEqual(body.input.slice(0, -1), JSON.parse(JSON.stringify(payload.input.slice(0, body.input.length - 1))));
	assert.deepEqual(body.tools, JSON.parse(JSON.stringify(payload.tools)));
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
	f.responses.push(response([{ type: "response.refusal.delta", delta: "Refused" }]));
	assert.deepEqual(await f.run(), { cancel: true });
	await f.capture({ ...payload, input: [{ role: "user", content: "Divergent" }] });
	assert.deepEqual(await f.run(), { cancel: true });
	assert.equal(f.http.length, 2, "divergent wire is rejected before HTTP");
});
