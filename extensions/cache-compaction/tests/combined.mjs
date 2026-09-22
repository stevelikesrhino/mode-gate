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
assert.equal(calls.length, 1, "Codex cannot fall through to text compaction");
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
const checkpointBranch = [...branch, checkpoint];
branch = [...checkpointBranch, entry("after", "cp", { ...userNext, content: "What token did I ask you to remember?" })];
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

// Pi 0.87 context edits must remain authoritative after an opaque checkpoint.
const editable = entry("editable", "cp", { ...userNext, content: "ORIGINAL TAIL CONTENT" });
const omission = {
	type: "context_edit", id: "omit-editable", parentId: "editable", timestamp: "2026-09-07T00:02:00Z",
	targetId: "editable", replacement: null,
};
let replayInput = native.effectiveInputForBranch({ branch: [...checkpointBranch, editable, omission], model, tools: [] });
assert.equal(JSON.stringify(replayInput).includes("ORIGINAL TAIL CONTENT"), false, "post-checkpoint omission is applied to Codex replay");
assert.deepEqual(replayInput, checkpoint.details.replacementHistory, "omitted tail contributes no replacement items");
const uneditedBranchInput = native.effectiveInputForBranch({ branch: [...checkpointBranch, editable], model, tools: [] });
assert.equal(JSON.stringify(uneditedBranchInput).includes("ORIGINAL TAIL CONTENT"), true, "context edits remain branch-relative");

const noCheckpointEditable = entry("no-checkpoint-editable", null, { ...userNext, content: "NO CHECKPOINT ORIGINAL" });
const noCheckpointOmission = {
	type: "context_edit", id: "omit-no-checkpoint", parentId: "no-checkpoint-editable", timestamp: "2026-09-07T00:02:00Z",
	targetId: "no-checkpoint-editable", replacement: null,
};
assert.deepEqual(
	native.effectiveInputForBranch({ branch: [noCheckpointEditable, noCheckpointOmission], model, tools: [] }),
	[],
	"canonical projection also applies edits before any checkpoint exists",
);

const failedAttempt = entry("failed-attempt", "cp", {
	...assistant,
	content: [{ type: "text", text: "ABANDONED LENGTH RESPONSE" }],
	stopReason: "length",
});
const recoveryOmission = {
	type: "context_edit", id: "omit-failed-attempt", parentId: "failed-attempt", timestamp: "2026-09-07T00:02:00Z",
	targetId: "failed-attempt", replacement: null,
};
replayInput = native.effectiveInputForBranch({ branch: [...checkpointBranch, failedAttempt, recoveryOmission], model, tools: [] });
assert.equal(JSON.stringify(replayInput).includes("ABANDONED LENGTH RESPONSE"), false, "0.87 recovery omission replaces the legacy last-assistant filter");
assert.deepEqual(replayInput, checkpoint.details.replacementHistory, "omitted length attempt contributes no replacement items");

const replacement = {
	type: "context_edit", id: "replace-editable", parentId: "editable", timestamp: "2026-09-07T00:02:00Z",
	targetId: "editable", replacement: { content: "REPLACED TAIL CONTENT" },
};
replayInput = native.effectiveInputForBranch({ branch: [...checkpointBranch, editable, replacement], model, tools: [] });
assert.equal(JSON.stringify(replayInput).includes("ORIGINAL TAIL CONTENT"), false, "post-checkpoint replacement removes original content");
assert.equal(JSON.stringify(replayInput).includes("REPLACED TAIL CONTENT"), true, "post-checkpoint replacement reaches Codex replay");
const latestReplacement = {
	...replacement,
	id: "replace-editable-again",
	parentId: "replace-editable",
	replacement: { content: "LATEST TAIL CONTENT" },
};
replayInput = native.effectiveInputForBranch({ branch: [...checkpointBranch, editable, replacement, latestReplacement], model, tools: [] });
assert.equal(JSON.stringify(replayInput).includes("REPLACED TAIL CONTENT"), false, "superseded context replacement is not replayed");
assert.equal(JSON.stringify(replayInput).includes("LATEST TAIL CONTENT"), true, "latest context replacement wins");

const toolCall = entry("tool-call", "cp", {
	...assistant,
	content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "true" } }],
	stopReason: "toolUse",
});
const toolResult = entry("tool-result", "tool-call", {
	role: "toolResult", toolCallId: "call-1", toolName: "bash",
	content: [{ type: "text", text: "ORIGINAL TOOL RESULT" }], isError: false, timestamp: 4,
});
const replaceToolResult = {
	type: "context_edit", id: "replace-tool-result", parentId: "tool-result", timestamp: "2026-09-07T00:02:00Z",
	targetId: "tool-result", replacement: { content: "REPLACED TOOL RESULT" },
};
replayInput = native.effectiveInputForBranch({ branch: [...checkpointBranch, toolCall, toolResult, replaceToolResult], model, tools: [] });
assert.equal(JSON.stringify(replayInput).includes("ORIGINAL TOOL RESULT"), false, "tool-result replacement removes original output");
assert.equal(replayInput.find((item) => item.type === "function_call_output")?.output, "REPLACED TOOL RESULT", "tool-result replacement is normalized for Codex replay");
const omitToolResult = { ...replaceToolResult, id: "omit-tool-result", replacement: null };
replayInput = native.effectiveInputForBranch({ branch: [...checkpointBranch, toolCall, toolResult, omitToolResult], model, tools: [] });
assert.equal(JSON.stringify(replayInput).includes("ORIGINAL TOOL RESULT"), false, "tool-result omission removes original output");
assert.equal(replayInput.find((item) => item.type === "function_call_output")?.output, "No result provided", "omitted tool result preserves a valid orphan-call placeholder");

const preCheckpointEdit = {
	type: "context_edit", id: "pre-checkpoint-edit", parentId: "tail", timestamp: "2026-09-07T00:00:30Z",
	targetId: "u", replacement: null,
};
const checkpointAfterEdit = { ...checkpoint, parentId: "pre-checkpoint-edit" };
assert.doesNotThrow(
	() => native.effectiveInputForBranch({ branch: [...checkpointBranch.slice(0, -1), preCheckpointEdit, checkpointAfterEdit], model, tools: [] }),
	"an edit already baked into an opaque checkpoint does not block replay",
);
const legacyCustomCheckpoint = {
	type: "custom", id: "legacy-custom-checkpoint", parentId: "tail", timestamp: "2026-09-07T00:01:00Z",
	customType: native.NATIVE_COMPACTION_KIND, data: checkpoint.details,
};
const customTail = entry("custom-tail", "legacy-custom-checkpoint", { ...userNext, content: "TAIL AFTER CUSTOM CHECKPOINT" });
replayInput = native.effectiveInputForBranch({ branch: [...checkpointBranch.slice(0, -1), legacyCustomCheckpoint, customTail], model, tools: [] });
assert.equal(replayInput.filter((item) => item.type === "compaction").length, 1, "old custom checkpoint format still replays its opaque item");
assert.equal(JSON.stringify(replayInput).includes("TAIL AFTER CUSTOM CHECKPOINT"), true, "old custom checkpoint format retains its canonical tail");

const opaqueEdit = {
	type: "context_edit", id: "edit-opaque", parentId: "cp", timestamp: "2026-09-07T00:02:00Z",
	targetId: "u", replacement: null,
};
assert.throws(
	() => native.effectiveInputForBranch({ branch: [...checkpointBranch, opaqueEdit], model, tools: [] }),
	/history inside the latest OpenAI Codex native compaction checkpoint/,
	"an edit targeting opaque pre-checkpoint history fails closed",
);
branch = [...checkpointBranch, opaqueEdit];
const beforeOpaqueAbort = aborted;
captured = await capture(originalPayload, ctx, [marker, userNext]);
assert.deepEqual(captured.payload.input, [], "opaque-history edit blocks the outgoing Codex request");
assert.equal(aborted, beforeOpaqueAbort + 1, "opaque-history edit aborts the active request");
const beforeOpaqueCompaction = calls.length;
assert.deepEqual(await compact(), { cancel: true }, "opaque-history edit also cancels checkpoint replacement");
assert.equal(calls.length, beforeOpaqueCompaction, "opaque-history edit fails before compaction network I/O");
branch = [...checkpointBranch, entry("after", "cp", { ...userNext, content: "What token did I ask you to remember?" })];

const differentModel = { ...ctx, model: { ...model, id: "other-codex-model" } };
const beforeWrongModelAbort = aborted;
await capture(originalPayload, differentModel, [marker, userNext]);
assert.equal(aborted, beforeWrongModelAbort + 1, "wrong-model opaque checkpoint blocks continuation");
const beforeFailure = calls.length;
result = await handlers.session_before_compact[0](compactEvent(), differentModel);
assert.deepEqual(result, { cancel: true });
assert.equal(calls.length, beforeFailure, "mismatched checkpoint never reaches network");

branch = [entry("u", null, user), entry("a", "u", assistant), entry("tail", "a", userNext)];
await capture(originalPayload);
respond = () => new Response("bad request", { status: 400 });
const beforeHttpFailure = calls.length;
assert.deepEqual(await compact(), { cancel: true });
assert.equal(calls.length, beforeHttpFailure + 1, "Codex error cancels without text fallback or permanent-error retry");
respond = () => new Response('data: {"type":"response.failed"}\n\n');
assert.deepEqual(await compact(), { cancel: true }, "failed SSE never creates a checkpoint");

// Regular providers keep text compaction and ordinary branch-summary context.
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
respond = () => Response.json({ choices: [{ message: { content: "## Goal\nRemember the migration token." }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 950, completion_tokens: 20 } });
const beforeRegular = calls.length;
result = await handlers.session_before_compact[0](compactEvent(), regularCtx);
assert.equal(calls.length, beforeRegular + 1);
assert.equal(result.compaction.details.kind, "cache-aligned-compaction");
assert.equal(result.compaction.usage.cacheRead, 950);
assert.equal(result.compaction.firstKeptEntryId, prep.firstKeptEntryId);
assert.equal(calls.at(-1).body.tool_choice, undefined);
assert.equal(calls.at(-1).body.input, undefined);
respond = () => new Response("bad request", { status: 400 });
assert.equal(await handlers.session_before_compact[0](compactEvent(), regularCtx), undefined, "text failures still fall back to native");

const beforeExcluded = calls.length;
const beforeAuth = authCalls;
for (const api of ["openai-completions", "openai-responses"]) {
	assert.equal(await handlers.session_before_compact[0](compactEvent(), { ...ctx, model: { ...model, provider: "openai", api } }), undefined);
}
assert.equal(calls.length, beforeExcluded);
assert.equal(authCalls, beforeAuth);
assert.equal(native.findNativeCheckpoint([checkpoint]).status, "valid");
const malformedBranch = [{ ...checkpoint, details: { ...checkpoint.details, replacementHistory: [] } }];
branch = malformedBranch;
const beforeMalformed = calls.length;
assert.deepEqual(await compact(), { cancel: true });
assert.equal(calls.length, beforeMalformed, "malformed persisted checkpoint cancels before any request");
branch = regularBranch;
const missingAuth = { ...ctx, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } };
assert.deepEqual(await handlers.session_before_compact[0](compactEvent(), missingAuth), { cancel: true });
assert.equal(calls.length, beforeMalformed, "Codex auth failure cannot fall through to text");
assert.equal(native.findNativeCheckpoint([{ ...checkpoint, details: { ...checkpoint.details, replacementHistory: [] } }]).status, "invalid");
console.log("Combined dispatcher, Codex replay/failure, provider isolation, and branch-summary tests passed.");
