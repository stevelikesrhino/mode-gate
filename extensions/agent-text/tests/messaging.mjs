import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const profile = await mkdtemp("/tmp/pi-agent-text-test-");
process.env.PI_CODING_AGENT_DIR = profile;
const { createJiti } = await import(join(root, "node_modules/jiti/lib/jiti-static.mjs"));
const jiti = createJiti(join(root, "dist/index.js"), {
	alias: {
		"@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
		"@earendil-works/pi-tui": join(root, "node_modules/@earendil-works/pi-tui/dist/index.js"),
		typebox: join(root, "node_modules/typebox/build/index.mjs"),
	},
	moduleCache: false,
});
const factory = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)), { default: true });
const { request, socketDirectory, MAX_TEXT_BYTES } = await jiti.import(fileURLToPath(new URL("../ipc.ts", import.meta.url)));
const { realpath } = await import("node:fs/promises");
const directory = socketDirectory(await realpath(profile));
const instances = [];
const servers = [];

async function agent(sessionId = randomUUID(), name = "test agent") {
	const handlers = {};
	const tools = {};
	const commands = {};
	const received = [];
	let idle = true;
	const ctx = {
		cwd: `/tmp/project-${name}`,
		model: { provider: "test", id: "model" },
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => idle,
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
	};
	const emit = async (type) => {
		for (const fn of handlers[type] ?? []) await fn({ type }, ctx);
	};
	factory({
		on(type, fn) { (handlers[type] ??= []).push(fn); },
		registerTool(tool) { tools[tool.name] = tool; },
		registerCommand(name, command) { commands[name] = command; },
		getSessionName: () => name,
		sendUserMessage(text, options) {
			received.push({ text, options });
			idle = false;
			void emit("agent_start");
		},
	});
	await emit("session_start");
	const call = async (name, args = {}, signal) => (await tools[name].execute("test", args, signal)).details;
	const self = (await call("list_agent")).self;
	const value = {
		self, sessionId, ctx, received, call, emit,
		command: (name) => commands[name].handler("", ctx),
		setIdle: (value) => { idle = value; },
		stop: () => emit("session_shutdown"),
	};
	instances.push(value);
	return value;
}

try {
	const a = await agent(undefined, "A");
	const b = await agent(undefined, "B");
	const c = await agent(undefined, "C");
	assert.equal((await stat(directory)).mode & 0o777, 0o700);
	assert.deepEqual(new Set((await a.call("list_agent")).agents.map((x) => x.id)), new Set([b.self, c.self]));
	console.log("PASS discovery across projects, self ID, private socket directory");
	await b.emit("session_start");
	assert.equal((await a.call("list_agent")).agents.length, 2);
	await b.stop();
	await b.stop();
	await b.emit("session_start");
	assert.equal((await b.call("list_agent")).agents.length, 2);
	console.log("PASS repeated startup/shutdown and same-instance restart are idempotent");

	let results = (await a.call("text_agent", { ids: [b.self, c.self, b.self, "missing", a.self], text: "hello\n你好\u2028literal" })).results;
	assert.deepEqual(results.map((x) => x.status), ["accepted", "accepted", "rejected", "rejected"]);
	assert.equal(b.received.length, 1);
	assert.equal(c.received.length, 1);
	assert.ok(b.received[0].text.includes(a.self));
	assert.ok(b.received[0].text.endsWith("hello\n你好\u2028literal"));
	assert.deepEqual(b.received[0].options, { deliverAs: "steer", expandPromptTemplates: false });
	assert.equal((await a.call("list_agent")).agents.find((x) => x.id === b.self).status, "busy");
	console.log("PASS fan-out, deduplication, partial failures, sender identity, Unicode, steering");

	await a.call("text_agent", { ids: [b.self], text: "/offline" });
	assert.ok((await a.call("list_agent")).agents.some((x) => x.id === b.self));
	assert.ok(b.received.at(-1).text.endsWith("/offline"));
	await assert.rejects(a.call("text_agent", { ids: [b.self], text: " " }), /nonempty/);
	await assert.rejects(a.call("text_agent", { ids: [b.self], text: "中".repeat(MAX_TEXT_BYTES) }), /16 KiB/);
	console.log("PASS command text stays literal, empty/oversize text rejected");

	await b.emit("session_before_compact");
	results = (await a.call("text_agent", { ids: [b.self, c.self], text: "compaction check" })).results;
	assert.deepEqual(results.map((x) => x.status), ["rejected", "accepted"]);
	assert.match(results[0].reason, /compacting/);
	await b.emit("session_compact_failed");
	assert.equal((await a.call("text_agent", { ids: [b.self], text: "after compaction" })).results[0].status, "accepted");
	await b.emit("agent_settled");
	b.setIdle(false);
	assert.match((await a.call("text_agent", { ids: [b.self], text: "transition" })).results[0].reason, /changing session/);
	b.setIdle(true);
	console.log("PASS compaction rejection/recovery and session-transition rejection");

	await b.command("offline");
	assert.ok(!(await a.call("list_agent")).agents.some((x) => x.id === b.self));
	assert.match((await a.call("text_agent", { ids: [b.self], text: "cached ID" })).results[0].reason, /Offline/);
	await assert.rejects(b.call("text_agent", { ids: [a.self], text: "outgoing" }), /offline/);
	await assert.rejects(b.call("list_agent"), /offline/);
	assert.ok(b.received.length > 0);
	const oldId = b.self;
	const sessionId = b.sessionId;
	await b.stop();
	assert.ok(!(await readdir(directory)).includes(`${oldId}.sock`));

	const handlers = {};
	const commands = {};
	const tools = {};
	factory({
		on(type, fn) { (handlers[type] ??= []).push(fn); },
		registerCommand(name, value) { commands[name] = value; },
		registerTool(value) { tools[value.name] = value; },
		getSessionName: () => "B resumed",
		sendUserMessage() { throw new Error("Offline session must not receive"); },
	});
	await handlers.session_start[0]({ reason: "reload" }, b.ctx);
	await assert.rejects(tools.list_agent.execute("test", {}), /offline/);
	await commands.online.handler("", b.ctx);
	assert.equal((await tools.list_agent.execute("test", {})).details.agents.length, 2);
	await handlers.session_shutdown[0]();
	const fork = await agent(undefined, "fork");
	assert.equal((await fork.call("list_agent")).agents.length, 2);
	await fork.stop();
	console.log("PASS offline hides/rejects both directions, persists on reload/resume; new session online; shutdown unlinks socket");

	const aborted = AbortSignal.abort();
	await assert.rejects(a.call("text_agent", { ids: [c.self], text: "cancelled" }, aborted), /abort/i);
	assert.equal((await request(directory, "..", { kind: "info" })).status, "rejected");
	assert.equal((await request(directory, oldId, { kind: "info" })).status, "rejected");
	assert.equal((await request(directory, c.self, { kind: "text", from: { id: a.self }, text: "" })).status, "rejected");
	console.log("PASS cancellation, path traversal, stale IDs, invalid inbound payload");

	const id = randomUUID().replaceAll("-", "");
	const broken = createServer((socket) => { socket.once("data", () => socket.destroy()); });
	await new Promise((resolve) => broken.listen(join(directory, `${id}.sock`), resolve));
	servers.push(broken);
	assert.equal((await request(directory, id, { kind: "text", from: { id: a.self }, text: "uncertain" })).status, "unknown");
	console.log("PASS lost acknowledgement reports unknown, not safe-to-retry rejection");

	const cancelled = new AbortController();
	const cancelId = randomUUID().replaceAll("-", "");
	const cancelling = createServer((socket) => { socket.once("data", () => { cancelled.abort(); socket.destroy(); }); });
	await new Promise((resolve) => cancelling.listen(join(directory, `${cancelId}.sock`), resolve));
	servers.push(cancelling);
	assert.equal((await request(directory, cancelId, { kind: "text", from: { id: a.self }, text: "cancel after send" }, cancelled.signal)).status, "unknown");
	const silentId = randomUUID().replaceAll("-", "");
	const silent = createServer((socket) => socket.resume());
	await new Promise((resolve) => silent.listen(join(directory, `${silentId}.sock`), resolve));
	servers.push(silent);
	const timeout = await request(directory, silentId, { kind: "text", from: { id: a.self }, text: "no receipt" });
	assert.equal(timeout.status, "unknown");
	assert.match(timeout.reason, /no acknowledgement/);
	console.log("PASS cancellation after sending and acknowledgement timeout both report unknown");

	const raw = createConnection(join(directory, c.self + ".sock"));
	await new Promise((resolve) => raw.once("connect", resolve));
	raw.on("error", () => {});
	const closed = new Promise((resolve) => raw.once("close", resolve));
	raw.write("x".repeat(130 * 1024));
	await closed;
	assert.ok((await a.call("list_agent")).agents.some((x) => x.id === c.self));
	console.log("PASS oversized socket frames cannot take down the listener");
} finally {
	for (const instance of instances) await instance.stop();
	for (const server of servers) await new Promise((resolve) => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
	await rm(profile, { recursive: true, force: true });
}
