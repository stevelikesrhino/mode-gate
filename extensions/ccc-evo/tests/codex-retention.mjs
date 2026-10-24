import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(path.join(root, "node_modules/jiti/lib/jiti-static.mjs"));
const { prepareCompaction } = await import(path.join(root, "dist/core/compaction/compaction.js"));
const jiti = createJiti(path.join(root, "dist/index.js"), {
	alias: Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-tui"].map(name => [
		`@earendil-works/${name}`, name === "pi-coding-agent" ? path.join(root, "dist/index.js") : path.join(root, "node_modules/@earendil-works", name, "dist/index.js"),
	])), moduleCache: false,
});
const native = await jiti.import(fileURLToPath(new URL("../codex/native-compaction.ts", import.meta.url)));
const { registerCodexCompaction } = await jiti.import(fileURLToPath(new URL("../codex/extension.ts", import.meta.url)));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "openai-codex", api: "openai-codex-responses", id: "fixture", baseUrl: "https://fixture.invalid", input: ["text"], contextWindow: 272000, maxTokens: 16384, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } };
const user = content => ({ role: "user", content, timestamp: 1 });
const assistant = content => ({ role: "assistant", content, provider: model.provider, api: model.api, model: model.id, stopReason: "toolUse", usage, timestamp: 2 });
const chain = messages => messages.map((message, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: "2026-01-01T00:00:00Z", message }));
const fixture = chain(Array.from({ length: 12 }, (_, i) => [
	user(`USER_${i}: ` + "u".repeat(4000)),
	assistant([
		{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "reasoning", id: `rs_${i}`, encrypted_content: `reasoning_${i}` }) },
		{ type: "text", text: `ASSISTANT_${i}: ` + "a".repeat(800), textSignature: `msg_${i}` },
		{ type: "toolCall", id: `call_${i}|fc_${i}`, name: "bash", arguments: { command: "fixture" } },
	]),
	{ role: "toolResult", toolCallId: `call_${i}|fc_${i}`, toolName: "bash", isError: false, timestamp: 3, content: [{ type: "text", text: `TOOL_${i}: ` + "t".repeat(12000) }] },
]).flat());
const compact = registerCodexCompaction({ on() {}, registerEntryRenderer() {}, getAllTools: () => [], getActiveTools: () => [], appendEntry() {} }, payload => payload);
const jwt = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.signature`;
const ctx = { model, mode: "print", hasUI: false, sessionManager: { getSessionId: () => "fixture" },
	modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwt }) }, getSystemPrompt: () => "Fixture" };
const replay = branch => native.effectiveInputForBranch({ branch, model, tools: [] });
const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
	requests.push(JSON.parse(init.body));
	return new Response([
		{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: `checkpoint_${requests.length}` } },
		{ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 80 } } } },
	].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
};
async function compactAt(branch, keepRecentTokens) {
	const preparation = prepareCompaction(branch, { enabled: true, reserveTokens: 15000, keepRecentTokens });
	assert.ok(preparation, "fixture has a compactable prefix");
	const before = structuredClone(branch);
	const result = await compact({ preparation, branchEntries: branch, signal: new AbortController().signal }, ctx);
	assert.ok(result?.compaction, "native compaction succeeds");
	assert.deepEqual(branch, before, "compaction is append-only");
	const checkpoint = { ...result.compaction, type: "compaction", id: `cp${requests.length}`, parentId: branch.at(-1).id, timestamp: "2026-01-01T00:01:00Z" };
	return { checkpoint, branch: [...branch, checkpoint], preparation, input: requests.at(-1).input.slice(0, -1) };
}
function assertPartition(before, result) {
	const full = replay(before);
	assert.deepEqual(result.input, full.slice(0, result.input.length), "request is an exact prefix of the effective history");
	assert.deepEqual(replay(result.branch), [...result.checkpoint.details.replacementHistory, ...full.slice(result.input.length)], "the entire retained suffix is replayed exactly once after the checkpoint");
	assert.deepEqual(requests.at(-1).input.at(-1), { type: "compaction_trigger" });
}
const edit = (branch, targetId, replacement) => [...branch, { type: "context_edit", id: `edit${branch.length}`, parentId: branch.at(-1).id, timestamp: "2026-01-01T00:02:00Z", targetId, replacement }];
try {
	const first = await compactAt(fixture, 16000);
	assertPartition(fixture, first);
	assert.equal(first.checkpoint.details.version, 2);
	assert.equal(first.checkpoint.usage.cacheRead, 80);
	assert.ok(first.checkpoint.usage.cost.total > 0, "reported usage retains calculated cost");
	const larger = await compactAt(fixture, 32000);
	assertPartition(fixture, larger);
	assert.ok(larger.input.length < first.input.length, "larger keepRecentTokens compacts less history");

	// A split user-message span keeps whole assistant/tool exchanges.
	const split = chain(fixture.filter(entry => entry.message.role !== "user" || entry.id === "e0").map(entry => entry.message));
	const splitResult = await compactAt(split, 16000);
	assert.equal(splitResult.preparation.isSplitTurn, true);
	assertPartition(split, splitResult);
	const splitReplay = replay(splitResult.branch);
	for (const call of splitReplay.filter(item => item.type === "function_call")) {
		assert.equal(splitReplay.filter(item => item.type === "function_call_output" && item.call_id === call.call_id).length, 1);
	}

	const restored = JSON.parse(JSON.stringify(first.branch));
	assert.deepEqual(replay(restored), replay(first.branch), "resume is derived entirely from saved state");
	assert.deepEqual(replay(fixture), replay(fixture.slice()), "navigating before compaction has no sticky checkpoint");
	const edited = edit(restored, "e35", { content: "EDITED_KEPT_TOOL" });
	assert.equal(replay(edited).find(item => item.call_id === "call_11" && item.type === "function_call_output").output, "EDITED_KEPT_TOOL");
	assert.ok(!JSON.stringify(replay(edit(restored, "e35", null))).includes("TOOL_11:"), "retained pre-checkpoint output may be omitted");
	assert.throws(() => replay(edit(restored, "e0", null)), /history inside/);
	assert.throws(() => replay([{ ...first.checkpoint, firstKeptEntryId: "missing" }]), /retained boundary/);
	assert.throws(() => native.effectiveInputForBranch({ branch: restored, model: { ...model, id: "other" }, tools: [] }), /different model/);
	assert.throws(() => native.compactionInputForBranch({ branch: fixture, model, tools: [], firstKeptEntryId: "missing" }), /retained boundary/);
	assert.throws(() => native.compactionInputForBranch({ branch: fixture, model, tools: [], firstKeptEntryId: "e0" }), /no OpenAI Codex history/);
	assert.equal(native.parseNativeCompactionDetails({ ...first.checkpoint.details, version: 99 }), undefined);
	assert.deepEqual(replay([...fixture, { ...first.checkpoint, firstKeptEntryId: first.checkpoint.id }]), first.checkpoint.details.replacementHistory, "retain-none checkpoints replay no preceding tail");

	// Edits after the cut must affect the prefix before it is sent, not disappear with slicing.
	const prefixEdited = edit(fixture, "e0", { content: "EDITED_PREFIX" });
	const prefixResult = await compactAt(prefixEdited, 16000);
	assertPartition(prefixEdited, prefixResult);
	assert.ok(JSON.stringify(prefixResult.input).includes("EDITED_PREFIX"));
	assert.ok(!JSON.stringify(prefixResult.input).includes("USER_0:"));

	const repeatBranch = [...edited, { ...fixture[0], id: "new-tail", parentId: edited.at(-1).id, message: user("LATEST_TAIL ".repeat(600)) }];
	const second = await compactAt(repeatBranch, 512);
	assertPartition(repeatBranch, second);
	assert.ok(second.input.some(item => item.encrypted_content === "checkpoint_1"), "recompaction consumes the prior opaque checkpoint");
	assert.ok(JSON.stringify(second.input).includes("EDITED_KEPT_TOOL"), "recompaction incorporates retained-tail edits");
	assert.equal(replay(second.branch).filter(item => item.type === "compaction").length, 1);
	assert.throws(() => replay(edit(second.branch, "e30", null)), /history inside/, "newly absorbed tail becomes opaque");

	// v1 never replays its nominal kept range, including after migration to v2.
	const legacy = { ...first.checkpoint, details: { ...first.checkpoint.details, version: 1, replacementHistory: native.buildReplacementHistory(replay(fixture), { type: "compaction", encrypted_content: "legacy" }) } };
	const legacyBranch = [...fixture, legacy];
	assert.deepEqual(replay(legacyBranch), legacy.details.replacementHistory);
	assert.throws(() => replay(edit(legacyBranch, "e35", null)), /history inside/);
	const later = { ...fixture[0], id: "later", parentId: legacy.id, message: user("LEGACY_TAIL") };
	const migrated = await compactAt([...legacyBranch, later], 8000);
	assert.equal(migrated.checkpoint.firstKeptEntryId, "later", "migration advances an absorbed legacy boundary");
	assertPartition([...legacyBranch, later], migrated);
	assert.ok(!JSON.stringify(replay(migrated.branch)).includes("TOOL_11:"), "migration cannot resurrect absorbed tool results");
	console.log("Codex prefix retention, split spans, edits, repeated compaction, resume, and legacy migration passed.");
} finally {
	globalThis.fetch = originalFetch;
}
