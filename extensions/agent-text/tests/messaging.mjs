import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const windows = process.platform === "win32";
const root = process.env.PI_ROOT ?? (windows
	? join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent")
	: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent");
const profile = await mkdtemp(join(tmpdir(), windows ? "pi-agent-text-test-你好 ' " : "pi-agent-text-test-"));
process.env.PI_CODING_AGENT_DIR = profile;
const { createJiti } = await import(pathToFileURL(join(root, "node_modules/jiti/lib/jiti-static.mjs")).href);
const jiti = createJiti(join(root, "dist/index.js"), {
	alias: {
		"@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
		"@earendil-works/pi-tui": join(root, "node_modules/@earendil-works/pi-tui/dist/index.js"),
		typebox: join(root, "node_modules/typebox/build/index.mjs"),
	},
	moduleCache: false,
});
const factory = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)), { default: true });
const { listen, request, socketDirectory, privateDirectory, MAX_TEXT_BYTES } = await jiti.import(fileURLToPath(new URL("../ipc.ts", import.meta.url)));
const { realpath } = await import("node:fs/promises");
const directory = socketDirectory(await realpath(profile));
const instances = [];
const servers = [];

async function serve(server, id) {
	await new Promise((resolve) => server.listen(windows ? { host: "127.0.0.1", port: 0 } : { path: join(directory, `${id}.sock`) }, resolve));
	servers.push(server);
	if (windows) await writeFile(join(directory, `${id}.sock`), JSON.stringify({ port: server.address().port, key: randomBytes(32).toString("hex") }));
}

async function connect(id) {
	if (!windows) return createConnection(join(directory, `${id}.sock`));
	const { port } = JSON.parse(await readFile(join(directory, `${id}.sock`), "utf8"));
	return createConnection({ host: "127.0.0.1", port });
}

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
	if (windows) await privateDirectory(directory);
	else assert.equal((await stat(directory)).mode & 0o777, 0o700);
	assert.deepEqual(new Set((await a.call("list_agent")).agents.map((x) => x.id)), new Set([b.self, c.self]));
	for (const peer of [a, b, c]) assert.match(peer.self, /^[a-f0-9]{8}$/);
	await assert.rejects(listen(join(directory, `${b.self}.sock`), () => ({ status: "rejected" })), { code: windows ? "EEXIST" : "EADDRINUSE" });
	assert.equal((await request(directory, b.self, { kind: "info" })).agent.id, b.self);
	console.log("PASS discovery across projects, eight-character IDs, collision protection, private socket directory");
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
	const escaped = "\0".repeat(MAX_TEXT_BYTES);
	assert.equal((await a.call("text_agent", { ids: [c.self], text: escaped })).results[0].status, "accepted");
	assert.ok(c.received.at(-1).text.endsWith(escaped));
	console.log("PASS command text stays literal, empty/oversize text rejected, maximum escaped text delivered");

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

	const id = randomBytes(4).toString("hex");
	let wire = "";
	const broken = createServer((socket) => { socket.once("data", (data) => { wire = data.toString(); socket.destroy(); }); });
	await serve(broken, id);
	assert.equal((await request(directory, id, { kind: "text", from: { id: a.self }, text: "uncertain" })).status, "unknown");
	if (windows) assert.ok(!wire.includes("uncertain") && !wire.includes(a.self));
	console.log("PASS lost acknowledgement reports unknown, not safe-to-retry rejection");

	const cancelled = new AbortController();
	const cancelId = randomBytes(4).toString("hex");
	const cancelling = createServer((socket) => { socket.once("data", () => { cancelled.abort(); socket.destroy(); }); });
	await serve(cancelling, cancelId);
	assert.equal((await request(directory, cancelId, { kind: "text", from: { id: a.self }, text: "cancel after send" }, cancelled.signal)).status, "unknown");
	const silentId = randomBytes(4).toString("hex");
	const silent = createServer((socket) => socket.resume());
	await serve(silent, silentId);
	const timeout = await request(directory, silentId, { kind: "text", from: { id: a.self }, text: "no receipt" });
	assert.equal(timeout.status, "unknown");
	assert.match(timeout.reason, /no acknowledgement/);
	console.log("PASS cancellation after sending and acknowledgement timeout both report unknown");

	if (windows) {
		const received = c.received.length;
		const unauthenticated = await connect(c.self);
		unauthenticated.on("error", () => {});
		const closed = new Promise((resolve) => unauthenticated.once("close", resolve));
		unauthenticated.write(JSON.stringify({ kind: "text", from: { id: a.self }, text: "unauthenticated" }) + "\n");
		await closed;
		assert.equal(c.received.length, received);
		const recordPath = join(directory, `${c.self}.sock`);
		const recordText = await readFile(recordPath, "utf8");
		const record = JSON.parse(recordText);
		await writeFile(recordPath, JSON.stringify({ ...record, key: randomBytes(32).toString("hex") }));
		assert.equal((await request(directory, c.self, { kind: "text", from: { id: a.self }, text: "wrong key" })).status, "unknown");
		assert.equal(c.received.length, received);
		await writeFile(recordPath, recordText);
		const spoofedId = randomBytes(4).toString("hex");
		await serve(createServer((socket) => socket.once("data", () => socket.end('{"status":"accepted"}\n'))), spoofedId);
		assert.equal((await request(directory, spoofedId, { kind: "text", from: { id: a.self }, text: "spoofed receipt" })).status, "unknown");
		await assert.rejects(privateDirectory(profile), /private, user-owned/);
		console.log("PASS unauthenticated/wrong-key frames, spoofed receipts, and inherited directory permissions rejected");
	}

	const raw = await connect(c.self);
	await new Promise((resolve) => raw.once("connect", resolve));
	raw.on("error", () => {});
	const closed = new Promise((resolve) => raw.once("close", resolve));
	raw.write("x".repeat(256 * 1024));
	await closed;
	assert.ok((await a.call("list_agent")).agents.some((x) => x.id === c.self));
	console.log("PASS oversized socket frames cannot take down the listener");
} finally {
	for (const instance of instances) await instance.stop();
	for (const server of servers) await new Promise((resolve) => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
	await rm(profile, { recursive: true, force: true });
}
