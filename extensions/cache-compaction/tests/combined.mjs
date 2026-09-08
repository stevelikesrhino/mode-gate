import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(path.join(root, "node_modules/jiti/lib/jiti-static.mjs"));
const jiti = createJiti(path.join(root, "dist/index.js"), {
	alias: Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-tui"].map((name) => [
		`@earendil-works/${name}`,
		name === "pi-coding-agent" ? path.join(root, "dist/index.js") : path.join(root, "node_modules/@earendil-works", name, "dist/index.js"),
	])),
	moduleCache: false,
});
const factory = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)), { default: true });
const native = await jiti.import(fileURLToPath(new URL("../codex/native-compaction.ts", import.meta.url)));
const { registerCodexCompaction, needsLegacyCompactionFallback } = await jiti.import(fileURLToPath(new URL("../codex/extension.ts", import.meta.url)));

const handlers = {};
const renderers = {};
const pi = {
	on(name, fn) { (handlers[name] ??= []).push(fn); },
	registerEntryRenderer(name, fn) { renderers[name] = fn; },
	getAllTools: () => [],
	getActiveTools: () => [],
	appendEntry: () => {},
};
factory(pi);
assert.equal(handlers.session_before_compact.length, 1, "one compaction dispatcher");
assert.equal(handlers.session_before_tree, undefined);
assert.equal(handlers.session_tree, undefined);
assert.equal(handlers.turn_end, undefined, "modern pi retains ownership of timing");
assert.ok(renderers["openai-codex-compaction-status"], "old status entries remain renderable");

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = { role: "user", content: "Remember the migration token is amber-migration-42.", timestamp: 1 };
const assistant = { role: "assistant", content: [{ type: "text", text: "Remembered." }], provider: "openai-codex", api: "openai-codex-responses", model: "gpt-5.6-luna", stopReason: "stop", usage, timestamp: 2 };
const userNext = { role: "user", content: "Continue.", timestamp: 3 };
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-09-07T00:00:00Z", message });
let branch = [entry("u", null, user), entry("a", "u", assistant), entry("tail", "a", userNext)];
const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-luna", baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 16384, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } };
const jwt = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
let authCalls = 0;
let aborted = 0;
const ctx = {
	model,
	mode: "print", hasUI: false,
	sessionManager: { getSessionId: () => "combined-test", getBranch: () => branch },
	modelRegistry: { getApiKeyAndHeaders: async () => { authCalls++; return { ok: true, apiKey: jwt, baseUrl: "https://proxy.example/codex" }; } },
	getSystemPrompt: () => "Test system prompt",
	abort: () => { aborted++; },
};
async function context(messages, current = ctx) {
	let event = { messages: structuredClone(messages) };
	for (const fn of handlers.context) {
		const result = await fn(event, current);
		if (result?.messages) event = { messages: result.messages };
	}
	return event.messages;
}
async function capture(payload, current = ctx, messages = [user, assistant, userNext]) {
	await context(messages, current);
	const event = { headers: { accept: "text/event-stream" } };
	for (const fn of handlers.before_provider_headers) await fn(event, current);
	let value = structuredClone(payload);
	for (const fn of handlers.before_provider_request) {
		const next = await fn({ payload: value }, current);
		if (next !== undefined) value = next;
	}
	return { payload: value, headers: event.headers };
}
const prep = { firstKeptEntryId: "tail", tokensBefore: 50000, messagesToSummarize: [user, assistant], turnPrefixMessages: [], isSplitTurn: false, fileOps: {}, settings: { reserveTokens: 0, keepRecentTokens: 16000 } };
const compactEvent = () => ({ preparation: prep, branchEntries: branch, reason: "manual", willRetry: false, signal: new AbortController().signal });
const compact = () => handlers.session_before_compact[0](compactEvent(), ctx);
const calls = [];
let respond;
globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return respond(); };
const opaque = { type: "compaction", encrypted_content: "test-opaque-checkpoint" };
const sse = () => new Response([
	{ type: "response.output_item.done", item: opaque },
	{ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 80 }, total_tokens: 110 } } },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

const originalPayload = { model: model.id, instructions: "Test system prompt", input: [{ role: "user", content: "original" }], stream: true, reasoning: { effort: "low" } };
let captured = await capture(originalPayload);
assert.deepEqual(captured.payload, originalPayload, "no checkpoint means ordinary Codex request is unchanged");
assert.match(captured.headers["x-codex-beta-features"], /remote_compaction_v2/);
respond = sse;
let result = await compact();
assert.equal(calls.length, 1, "one Codex remote compaction request");
assert.equal(calls[0].url, "https://proxy.example/codex/responses", "auth baseUrl override honored");
assert.deepEqual(calls[0].body.input.at(-1), { type: "compaction_trigger" });
assert.equal(calls[0].body.reasoning.effort, "low");
assert.equal(result.compaction.details.kind, "openai-codex-native-compaction");
assert.equal(result.compaction.firstKeptEntryId, prep.firstKeptEntryId);
assert.equal(result.compaction.usage.cacheRead, 80);
assert.equal(result.compaction.usage.input, 20);
assert.deepEqual(result.compaction.details.replacementHistory.at(-1), opaque);
assert.equal(calls[0].init.headers.get("chatgpt-account-id"), "test-account");

// Replay old-package checkpoint entries, including local-marker suppression.
const checkpoint = { ...result.compaction, type: "compaction", id: "cp", parentId: "tail", timestamp: "2026-09-07T00:01:00Z" };
branch = [...branch, checkpoint, entry("after", "cp", { ...userNext, content: "What token did I ask you to remember?" })];
const marker = { role: "compactionSummary", summary: checkpoint.summary, tokensBefore: 50000, timestamp: 4 };
assert.deepEqual(await context([marker, userNext]), [userNext]);
captured = await capture({ ...originalPayload, previous_response_id: "stale" }, ctx, [marker, userNext]);
assert.equal(captured.payload.previous_response_id, undefined);
assert.equal(captured.payload.input.filter((item) => item.type === "compaction").length, 1);
assert.ok(!JSON.stringify(captured.payload).includes(checkpoint.summary));
assert.match(JSON.stringify(captured.payload.input.at(-1)), /What token/);
respond = sse;
result = await compact();
assert.equal(result.compaction.details.replacementHistory.filter((item) => item.type === "compaction").length, 1, "repeat compaction replaces opaque checkpoint");

const differentModel = { ...ctx, model: { ...model, id: "other-codex-model" } };
await capture(originalPayload, differentModel, [marker, userNext]);
assert.equal(aborted, 1, "wrong-model opaque checkpoint blocks continuation");
const beforeFailure = calls.length;
result = await handlers.session_before_compact[0](compactEvent(), differentModel);
assert.deepEqual(result, { cancel: true });
assert.equal(calls.length, beforeFailure, "mismatched checkpoint never reaches network");

branch = [entry("u", null, user), entry("a", "u", assistant), entry("tail", "a", userNext)];
await capture(originalPayload);
respond = () => new Response("bad request", { status: 400 });
const beforeHttpFailure = calls.length;
assert.deepEqual(await compact(), { cancel: true });
assert.equal(calls.length, beforeHttpFailure + 1, "Codex error cancels without native fallback or permanent-error retry");
respond = () => new Response('data: {"type":"response.failed"}\n\n');
assert.deepEqual(await compact(), { cancel: true }, "failed SSE never creates a checkpoint");

// Regular providers use pi's native compaction and keep branch-summary context.
const regularCtx = { ...ctx, model: { ...model, provider: "deepseek", api: "openai-completions", id: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" } };
const branchSummary = { role: "branchSummary", summary: "Regular native branch summary", fromId: "other", timestamp: 5 };
assert.deepEqual(await context([branchSummary, user], regularCtx), [branchSummary, user]);
const regularBranch = branch;
branch = [...branch, checkpoint];
assert.deepEqual(await context([marker, branchSummary, userNext], regularCtx), [branchSummary, userNext], "provider switch hides only the local Codex marker, not branch summaries");
branch = regularBranch;
const chat = { model: regularCtx.model.id, messages: [{ role: "system", content: "Test system prompt" }, { role: "user", content: user.content }, { role: "assistant", content: "Remembered." }, { role: "user", content: "Continue." }], stream: true, tools: [{ type: "function", function: { name: "read", parameters: {} } }] };
captured = await capture(chat, regularCtx);
assert.deepEqual(captured.payload, chat);
assert.equal(captured.headers["x-codex-beta-features"], undefined);
const beforeRegular = calls.length;
const beforeRegularAuth = authCalls;
for (const api of ["openai-completions", "anthropic-messages", "openai-responses"]) {
	result = await handlers.session_before_compact[0](compactEvent(), { ...regularCtx, model: { ...regularCtx.model, api } });
	assert.equal(result, undefined, `${api} compaction stays native`);
}
assert.equal(calls.length, beforeRegular, "non-Codex compaction makes no extension requests");
assert.equal(authCalls, beforeRegularAuth, "non-Codex compaction does not resolve extension auth");

const beforeExcluded = calls.length;
const beforeAuth = authCalls;
for (const api of ["openai-completions", "openai-responses"]) {
	assert.equal(await handlers.session_before_compact[0](compactEvent(), { ...ctx, model: { ...model, provider: "openai", api } }), undefined);
}
assert.equal(calls.length, beforeExcluded);
assert.equal(authCalls, beforeAuth);
assert.equal(needsLegacyCompactionFallback("0.84.3"), true);
assert.equal(needsLegacyCompactionFallback("0.84.4"), false);
const legacyEvents = [];
assert.equal(typeof registerCodexCompaction({ ...pi, on: (name) => legacyEvents.push(name) }, "0.84.3"), "function");
assert.ok(legacyEvents.includes("turn_end") && legacyEvents.includes("agent_settled"));
assert.equal(native.findNativeCheckpoint([checkpoint]).status, "valid");
const malformedBranch = [{ ...checkpoint, details: { ...checkpoint.details, replacementHistory: [] } }];
branch = malformedBranch;
const beforeMalformed = calls.length;
assert.deepEqual(await compact(), { cancel: true });
assert.equal(calls.length, beforeMalformed, "malformed persisted checkpoint cancels before any request");
branch = regularBranch;
const missingAuth = { ...ctx, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } };
assert.deepEqual(await handlers.session_before_compact[0](compactEvent(), missingAuth), { cancel: true });
assert.equal(calls.length, beforeMalformed, "Codex auth failure cannot fall through to native compaction");
assert.equal(native.findNativeCheckpoint([{ ...checkpoint, details: { ...checkpoint.details, replacementHistory: [] } }]).status, "invalid");
console.log("Codex compaction, replay/failure, provider isolation, and branch-summary tests passed.");
