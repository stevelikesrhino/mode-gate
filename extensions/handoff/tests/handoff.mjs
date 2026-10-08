import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(path.join(root, "node_modules/jiti/lib/jiti-static.mjs"));
const jiti = createJiti(path.join(root, "dist/index.js"), {
	alias: {
		"@earendil-works/pi-coding-agent": path.join(root, "dist/index.js"),
		"@earendil-works/pi-ai": path.join(root, "node_modules/@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-tui": path.join(root, "node_modules/@earendil-works/pi-tui/dist/index.js"),
	},
	moduleCache: false,
});
const factory = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)), { default: true });
const { SessionManager } = await import(path.join(root, "dist/index.js"));
const { getCurrentSystemPrompt, getCurrentTools, normalizeContext } = await import(
	path.join(root, "node_modules/@earendil-works/pi-ai/dist/index.js")
);

const sandbox = await mkdtemp(path.join(tmpdir(), "pi-handoff-test-"));
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model = {
	provider: "test",
	api: "openai-responses",
	id: "test-model",
	name: "Test model",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const parameters = { type: "object", properties: {} };
const readTool = { name: "read", description: "Read files", parameters };
const editTool = { name: "edit", description: "Edit files", parameters };

function assistant(text) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function okResponse(text = "generated handoff") {
	return { ...assistant(text), content: [{ type: "text", text }] };
}

async function runHandoff({
	name,
	session,
	effectivePrompt,
	currentPrompt,
	activeTools = [readTool],
	thinkingLevel = "high",
	response = okResponse(),
	streamError,
	resultError,
}) {
	const cwd = path.join(sandbox, name);
	await mkdir(cwd, { recursive: true });
	const commands = {};
	const notifications = [];
	const calls = [];
	const pi = {
		registerCommand(commandName, command) { commands[commandName] = command; },
		on() {},
		getActiveTools: () => activeTools.map((tool) => tool.name),
		getAllTools: () => activeTools,
		getThinkingLevel: () => thinkingLevel,
	};
	factory(pi);
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		model,
		thinkingLevel,
		sessionManager: session,
		isIdle: () => true,
		waitForIdle: async () => {},
		getSystemPrompt: () => effectivePrompt ?? currentPrompt ?? getCurrentSystemPrompt(session.buildSessionProjection().messages),
		// Command options expose base prompt inputs; getSystemPrompt() exposes the
		// current effective prompt even when the transcript records an older prompt.
		getSystemPromptOptions: () => ({ cwd }),
		modelRegistry: {
			streamSimple(requestModel, context, options) {
				if (streamError) throw streamError;
				calls.push({ model: requestModel, context, options });
				return {
					async result() {
						if (resultError) throw resultError;
						return response;
					},
				};
			},
		},
		ui: {
			setWidget() {},
			notify(message, level) { notifications.push({ message, level }); },
			theme: { fg: (_color, text) => text },
		},
	};
	await commands.handoff.handler("", ctx);
	return { cwd, calls, notifications };
}

function systemMessage(content, extra = {}) {
	return { role: "system", content, timestamp: Date.now(), ...extra };
}

await test("handoff uses the canonical projection, prompt deltas, and tool state once", async () => {
	const session = SessionManager.inMemory(sandbox, { id: "canonical" });
	session.appendMessage(systemMessage("", {
		sections: { preamble: "BASE PROMPT" },
		toolsAdded: [readTool],
	}));
	const omittedId = session.appendMessage({ role: "user", content: "OMIT-SECRET", timestamp: Date.now() });
	session.appendMessage(assistant("intermediate answer"));
	const replacedId = session.appendMessage({ role: "user", content: "OLD REQUEST", timestamp: Date.now() });
	session.appendMessage(systemMessage("", {
		sections: { preamble: "UPDATED PROMPT", extra: "EXTRA RULE" },
		toolsRemoved: [{ name: "read" }],
		toolsAdded: [editTool],
	}));
	session.appendContextEdit(omittedId, null);
	session.appendContextEdit(replacedId, { content: "REPLACEMENT REQUEST" });

	assert.match(JSON.stringify(session.buildContextEntries()), /OMIT-SECRET/,
		"raw compaction entries retain append-only history");
	assert.match(JSON.stringify(session.buildContextEntries()), /OLD REQUEST/);

	const result = await runHandoff({ name: "canonical", session });
	assert.equal(result.calls.length, 1);
	const call = result.calls[0];
	assert.equal(Object.hasOwn(call.context, "systemPrompt"), false);
	assert.equal(Object.hasOwn(call.context, "tools"), false);
	assert.equal(call.context.messages.filter((message) => message.role === "system").length, 2,
		"canonical system checkpoints are not duplicated");
	assert.doesNotMatch(JSON.stringify(call.context.messages), /OMIT-SECRET|OLD REQUEST/);
	assert.match(JSON.stringify(call.context.messages), /REPLACEMENT REQUEST/);
	assert.match(getCurrentSystemPrompt(call.context.messages), /UPDATED PROMPT/);
	assert.doesNotMatch(getCurrentSystemPrompt(call.context.messages), /BASE PROMPT/);
	assert.match(getCurrentSystemPrompt(call.context.messages), /EXTRA RULE/);
	assert.deepEqual(getCurrentTools(call.context.messages).map((tool) => tool.name), ["edit"]);
	assert.equal(call.context.messages.at(-1).role, "user");
	assert.match(call.context.messages.at(-1).content[0].text, /conversation to summarize/);
	assert.equal(call.options.reasoning, "high");
	assert.equal(call.options.maxTokens, 8192);
	assert.equal(call.options.sessionId, "canonical");
	assert.equal(await readFile(path.join(result.cwd, "HANDOFF.md"), "utf8"), "generated handoff\n");
});

await test("handoff projects a current prompt that differs from the recorded transcript", async () => {
	const session = SessionManager.inMemory(sandbox, { id: "forced" });
	session.appendMessage(systemMessage("", {
		sections: { preamble: "STRUCTURED PROMPT" },
		toolsAdded: [readTool],
	}));
	session.appendMessage({ role: "user", content: "work item", timestamp: Date.now() });
	session.appendMessage(systemMessage("", {
		toolsRemoved: [{ name: "read" }],
		toolsAdded: [editTool],
	}));

	const result = await runHandoff({
		name: "forced",
		session,
		effectivePrompt: "CURRENT EFFECTIVE PROMPT",
		activeTools: [readTool, editTool],
	});
	const context = result.calls[0].context;
	assert.equal(Object.hasOwn(context, "systemPrompt"), false);
	assert.equal(Object.hasOwn(context, "tools"), false);
	assert.equal(context.messages.filter((message) => message.role === "system").length, 1);
	assert.equal(getCurrentSystemPrompt(context.messages), "CURRENT EFFECTIVE PROMPT");
	assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name), ["edit"]);
	assert.doesNotMatch(JSON.stringify(context.messages), /STRUCTURED PROMPT/);
});

await test("handoff supplies the current prompt and tools once for a legacy session without system messages", async () => {
	const session = SessionManager.inMemory(sandbox, { id: "legacy" });
	session.appendMessage({ role: "user", content: "legacy work", timestamp: Date.now() });

	const result = await runHandoff({
		name: "legacy",
		session,
		currentPrompt: "LEGACY CURRENT PROMPT",
		activeTools: [readTool],
		thinkingLevel: "off",
	});
	const call = result.calls[0];
	assert.equal(call.context.systemPrompt, "LEGACY CURRENT PROMPT");
	assert.deepEqual(call.context.tools.map((tool) => tool.name), ["read"]);
	assert.equal(call.context.messages.some((message) => message.role === "system"), false);
	const normalized = normalizeContext(call.context);
	assert.equal(normalized.messages.filter((message) => message.role === "system").length, 1);
	assert.equal(getCurrentSystemPrompt(normalized.messages), "LEGACY CURRENT PROMPT");
	assert.deepEqual(getCurrentTools(normalized.messages).map((tool) => tool.name), ["read"]);
	assert.equal(call.options.reasoning, undefined);
});

await test("handoff does not call a provider when finalized context has no conversation", async () => {
	const session = SessionManager.inMemory(sandbox, { id: "empty" });
	session.appendMessage(systemMessage("", { sections: { preamble: "PROMPT ONLY" } }));
	const userId = session.appendMessage({ role: "user", content: "removed", timestamp: Date.now() });
	session.appendContextEdit(userId, null);

	const result = await runHandoff({ name: "empty", session });
	assert.equal(result.calls.length, 0);
	assert.deepEqual(result.notifications, [{ message: "No conversation to hand off", level: "warning" }]);
	await assert.rejects(access(path.join(result.cwd, "HANDOFF.md")));
});

await test("handoff reports configured stream setup and provider result errors", async (t) => {
	await t.test("synchronous stream setup error", async () => {
		const session = SessionManager.inMemory(sandbox, { id: "setup-error" });
		session.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		const result = await runHandoff({
			name: "setup-error",
			session,
			streamError: new Error("configured provider unavailable"),
		});
		assert.match(result.notifications.at(-1).message, /configured provider unavailable/);
		assert.equal(result.notifications.at(-1).level, "error");
		await assert.rejects(access(path.join(result.cwd, "HANDOFF.md")));
	});

	await t.test("error response", async () => {
		const session = SessionManager.inMemory(sandbox, { id: "response-error" });
		session.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		const result = await runHandoff({
			name: "response-error",
			session,
			response: { ...assistant(""), stopReason: "error", errorMessage: "provider rejected request" },
		});
		assert.match(result.notifications.at(-1).message, /provider rejected request/);
		assert.equal(result.notifications.at(-1).level, "error");
		await assert.rejects(access(path.join(result.cwd, "HANDOFF.md")));
	});

	for (const stopReason of ["length", "aborted", "toolUse", "deferred", "pending"]) {
		await t.test(`${stopReason} response preserves an existing handoff`, async () => {
			const name = `incomplete-${stopReason}`;
			const cwd = path.join(sandbox, name);
			await mkdir(cwd, { recursive: true });
			const existing = Buffer.from("existing handoff\r\nkept byte-for-byte\n", "utf8");
			await writeFile(path.join(cwd, "HANDOFF.md"), existing);
			const session = SessionManager.inMemory(sandbox, { id: name });
			session.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
			const result = await runHandoff({
				name,
				session,
				response: { ...assistant("partial handoff"), stopReason },
			});
			assert.match(result.notifications.at(-1).message, new RegExp(stopReason, "i"));
			assert.equal(result.notifications.at(-1).level, "error");
			assert.deepEqual(await readFile(path.join(cwd, "HANDOFF.md")), existing);
		});
	}

	await t.test("completed response containing a tool call preserves an existing handoff", async () => {
		const name = "tool-call-response";
		const cwd = path.join(sandbox, name);
		await mkdir(cwd, { recursive: true });
		const existing = Buffer.from("existing handoff without replacement\n", "utf8");
		await writeFile(path.join(cwd, "HANDOFF.md"), existing);
		const session = SessionManager.inMemory(sandbox, { id: name });
		session.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		const result = await runHandoff({
			name,
			session,
			response: {
				...assistant("partial handoff"),
				content: [
					{ type: "text", text: "partial handoff" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
				],
			},
		});
		assert.match(result.notifications.at(-1).message, /attempted to call a tool/i);
		assert.equal(result.notifications.at(-1).level, "error");
		assert.deepEqual(await readFile(path.join(cwd, "HANDOFF.md")), existing);
	});

	await t.test("result rejection", async () => {
		const session = SessionManager.inMemory(sandbox, { id: "result-error" });
		session.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		const result = await runHandoff({
			name: "result-error",
			session,
			resultError: new Error("stream result failed"),
		});
		assert.match(result.notifications.at(-1).message, /stream result failed/);
		assert.equal(result.notifications.at(-1).level, "error");
		await assert.rejects(access(path.join(result.cwd, "HANDOFF.md")));
	});
});

await rm(sandbox, { recursive: true, force: true });
