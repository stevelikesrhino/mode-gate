import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (process.platform === "win32") {
	console.log("SKIP claude adapter: native Windows runtime is unverified");
	process.exit(0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "pi-cc-"));
const profile = join(work, "p");
const config = join(work, "c");
const project = join(work, "project");
const inbox = join(work, "1.sock");
const token = randomUUID().replaceAll("-", "");
const envSession = randomUUID();
const registrySession = randomUUID();
const id = createHash("sha256").update(envSession).digest("hex").slice(0, 8);
const peerId = "0a0a0a0a";
const recordPath = join(config, "sessions", `${process.pid}.json`);
const statePath = join(config, "agent-text", basename(inbox));
const outfile = join(work, "claude-mcp.mjs");
await mkdir(profile, { recursive: true, mode: 0o700 });
await mkdir(project, { recursive: true });
await mkdir(join(config, "sessions"), { recursive: true, mode: 0o700 });
const directory = `/tmp/pi-agent-text-${process.getuid()}-${createHash("sha256").update(await realpath(profile)).digest("hex").slice(0, 12)}`;

await build({
	absWorkingDir: root,
	entryPoints: ["claude-mcp.ts"],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});

const base = {
	pid: process.pid, sessionId: registrySession, cwd: "/launch", version: "2.1.296", peerProtocol: 1, kind: "interactive",
	messagingSocketPath: inbox, name: "Audit session", nameSource: "auto", status: "busy",
};
async function record(overrides = {}) {
	const value = { ...base, ...overrides };
	for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
	await writeFile(recordPath, JSON.stringify(value));
}

const servers = [];
function serve(path, handle) {
	const server = createServer((socket) => {
		let data = "";
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.on("data", (chunk) => { data += chunk; });
		socket.on("end", () => handle(data.split("\n").filter(Boolean).map((line) => JSON.parse(line)), socket));
	});
	servers.push(server);
	return new Promise((resolve) => server.listen(path, () => resolve(server)));
}
const inboxFrames = [];
let inboxServer = await serve(inbox, (frames, socket) => { inboxFrames.push(frames); socket.end(); });

function peer(value, agent = id) {
	return new Promise((resolve, reject) => {
		const socket = createConnection(join(directory, `${agent}.sock`));
		let data = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => { data += chunk; });
		socket.on("error", reject);
		socket.on("close", () => {
			try { resolve(JSON.parse(data.slice(0, data.indexOf("\n")))); } catch (error) { reject(error); }
		});
		socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
	});
}
const info = () => peer({ kind: "info" });
function http(method, path, body) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ socketPath: statePath, method, path }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => resolve({ status: res.statusCode, text }));
		});
		req.on("error", reject);
		req.end(body);
	});
}
const pushState = (state) => http("POST", "/state", JSON.stringify(state));
async function waitFor(check, what) {
	for (let i = 0; i < 50; i++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

await record();
const child = spawn(process.execPath, [outfile, "--profile", profile], {
	stdio: ["pipe", "pipe", "pipe"],
	env: {
		...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_MESSAGING_SOCKET: inbox, CLAUDE_CODE_MESSAGING_TOKEN: token,
		CLAUDE_CODE_SESSION_ID: envSession, CLAUDE_PROJECT_DIR: project,
	},
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
const pending = new Map();
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let end;
	while ((end = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, end);
		buffer = buffer.slice(end + 1);
		if (!line.trim()) continue;
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
let nextId = 1;
function rpc(method, params) {
	return new Promise((resolve, reject) => {
		const rpcId = nextId++;
		pending.set(rpcId, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }) + "\n");
		setTimeout(() => { if (pending.delete(rpcId)) reject(new Error(`No response to ${method}`)); }, 5000);
	});
}
const call = async (name, args = {}) => {
	const result = await rpc("tools/call", { name, arguments: args });
	const text = result.content[0].text;
	return { isError: result.isError === true, value: result.isError ? text : JSON.parse(text) };
};

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
	assert.ok(initialized.instructions.includes(`Your agent-text ID is ${id}.`), "ID derives from the spawn-time session");
	child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
	await waitFor(() => stat(statePath).then(() => true, () => false), "state socket");
	console.log("PASS adapter starts from a fixture registry and opens the state socket");

	const { tools } = await rpc("tools/list");
	assert.deepEqual(tools.map((tool) => tool.name).sort(), ["list_agent", "text_agent"]);
	for (const tool of tools) assert.equal(tool._meta["anthropic/alwaysLoad"], true, `${tool.name} loads upfront`);
	console.log("PASS both tools are marked anthropic/alwaysLoad");

	let agent = (await info()).agent;
	assert.equal(agent.id, id);
	assert.equal(agent.kind, "claude");
	assert.equal(agent.sessionId, registrySession, "registry session beats spawn-time env");
	assert.equal(agent.status, "busy", "registry status used");
	assert.equal(agent.name, "Audit session");
	assert.equal(agent.cwd, project);
	assert.equal(agent.model, undefined);
	await record({ sessionId: undefined, status: undefined });
	agent = (await info()).agent;
	assert.equal(agent.sessionId, envSession, "env session is the fallback");
	assert.equal(agent.status, "unknown");
	for (const overrides of [
		{ sessionId: 123 }, { sessionId: "" }, { sessionId: "x".repeat(129) }, { sessionId: null },
		{ status: "running" }, { status: 1 }, { status: null }, { status: ["idle"] },
	]) {
		await record({ sessionId: undefined, status: undefined, ...overrides });
		const response = await info();
		assert.equal(response.status, "ok", `malformed optional field keeps the agent reachable: ${JSON.stringify(overrides)}`);
		assert.equal(response.agent.sessionId, envSession, JSON.stringify(overrides));
		assert.equal(response.agent.status, "unknown", JSON.stringify(overrides));
	}
	await record({ name: "agent-12", nameSource: "derived" });
	assert.equal((await info()).agent.name, `Claude ${basename(project)} (${id})`, "derived names are placeholders");
	console.log("PASS info prefers the registry record and falls back to the environment");

	assert.equal((await pushState({ sessionId: registrySession, cwd: "/real/project", model: "claude-opus", status: "idle" })).status, 204);
	await record();
	agent = (await info()).agent;
	assert.equal(agent.model, "claude-opus", "mod model for the current session");
	assert.equal(agent.cwd, "/real/project", "mod cwd is kept");
	assert.equal(agent.status, "busy", "registry status beats the mod");
	await record({ status: undefined });
	assert.equal((await info()).agent.status, "idle", "mod status is the fallback");
	assert.equal((await pushState({ sessionId: envSession, cwd: "/stale", model: "claude-haiku", status: "idle" })).status, 204);
	agent = (await info()).agent;
	assert.equal(agent.sessionId, registrySession);
	assert.equal(agent.model, undefined, "model from a stale session report is ignored");
	assert.equal(agent.status, "unknown", "status from a stale session report is ignored");
	assert.equal(agent.cwd, "/stale", "cwd survives a session change");
	await record({ sessionId: undefined, status: undefined });
	agent = (await info()).agent;
	assert.equal(agent.sessionId, envSession);
	assert.equal(agent.model, "claude-haiku", "mod report matching the fallback session counts");
	assert.equal((await pushState({ sessionId: registrySession, cwd: "", model: "", status: "nope" })).status, 400);
	assert.equal((await http("POST", "/state", "{")).status, 400);
	assert.equal((await pushState("{")).status, 400);
	assert.equal((await http("GET", "/state")).status, 400);
	await record();
	console.log("PASS mod state merges only for the current session; bad reports are rejected");

	await mkdir(join(config, "jobs", "0123abcd"), { recursive: true });
	await writeFile(join(config, "jobs", "0123abcd", "state.json"), JSON.stringify({ respawnFlags: ["--model", "claude-sonnet", "--", "-m", "x"] }));
	await pushState({ sessionId: registrySession, cwd: "/real/project", model: "claude-opus", status: "idle" });
	await record({ kind: "bg", jobId: "0123abcd" });
	assert.equal((await info()).agent.model, "claude-opus", "mod model wins when current");
	await pushState({ sessionId: envSession, cwd: "/stale", status: "idle" });
	assert.equal((await info()).agent.model, "claude-sonnet", "job state model is the fallback");
	await writeFile(join(config, "jobs", "0123abcd", "state.json"), JSON.stringify({ respawnFlags: ["--model", "default"] }));
	assert.equal((await info()).agent.model, undefined);
	await writeFile(join(config, "jobs", "0123abcd", "state.json"), JSON.stringify({ respawnFlags: ["--model", "-bad"] }));
	assert.equal((await info()).agent.model, undefined);
	await record();
	await pushState({ sessionId: registrySession, cwd: "/real/project", model: "claude-opus", status: "idle" });
	console.log("PASS background-job model aliases are read only as a fallback");

	const text = { kind: "text", from: { id: peerId, name: "Pi" }, text: "hello" };
	for (const [overrides, pattern] of [
		[{ spare: true }, /spare/],
		[{ parkedJobId: "0123abcd" }, /parked/],
		[{ messagingSocketPath: join(work, "2.sock") }, /inbox/],
		[{ peerProtocol: 2 }, /incompatible/],
		[{ peerProtocol: undefined }, /incompatible/],
		[{ version: "2.1" }, /incompatible/],
		[{ pid: process.pid + 1 }, /incompatible/],
		[{ kind: "worker" }, /incompatible/],
	]) {
		await record(overrides);
		const response = await info();
		assert.equal(response.status, "rejected", JSON.stringify(overrides));
		assert.match(response.reason, pattern);
		assert.equal((await peer(text)).status, "rejected");
	}
	await rm(recordPath);
	assert.equal((await info()).status, "rejected");
	await record();
	assert.equal((await info()).status, "ok");
	assert.equal(inboxFrames.length, 0, "filtered requests never reach the inbox");
	console.log("PASS spare, parked, mismatched, and incompatible owner records disable messaging");

	let receipt = await peer(text);
	assert.equal(receipt.status, "accepted");
	assert.equal(receipt.reason, "Write completed; not acknowledged by Claude. Inbound controls may hold or refuse it; not confirmation of model processing.");
	await waitFor(() => inboxFrames.length === 1, "inbox frames");
	const [auth, user] = inboxFrames[0];
	assert.deepEqual(auth, { type: "auth", token });
	assert.equal(user.type, "user");
	assert.equal(user.from, `agent-text:${peerId}`);
	assert.equal(user.priority, "next");
	assert.equal(user.message.content, `[Message from agent ${peerId} — "Pi"]\nhello`);
	assert.match(user.uuid, /^[0-9a-f-]{36}$/);
	receipt = await peer({ ...text, from: { id } });
	assert.equal(receipt.status, "rejected");
	assert.match(receipt.reason, /yourself/);
	assert.equal((await peer({ kind: "text", from: { id: peerId }, text: " " })).status, "rejected");
	assert.equal((await peer({ kind: "text", from: { id: "bad id" }, text: "x" })).status, "rejected");
	await new Promise((resolve) => inboxServer.close(resolve));
	await rm(inbox, { force: true });
	receipt = await peer(text);
	assert.equal(receipt.status, "rejected");
	assert.match(receipt.reason, /unavailable/);
	inboxServer = await serve(inbox, (frames, socket) => { inboxFrames.push(frames); socket.end(); });
	console.log("PASS receipts describe an unacknowledged inbox write; a dead inbox rejects");

	// Peers answer the first frame without waiting for the client to close.
	const peerFrames = [];
	const peerServer = createServer((socket) => {
		let data = "";
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			data += chunk;
			if (!data.includes("\n")) return;
			const frame = JSON.parse(data.slice(0, data.indexOf("\n")));
			peerFrames.push(frame);
			socket.end(JSON.stringify(frame.kind === "info"
				? { status: "ok", agent: { id: peerId, sessionId: "s", cwd: "/pi", status: "idle", kind: "pi", provider: "anthropic", model: "m" } }
				: { status: "accepted" }) + "\n");
		});
	});
	servers.push(peerServer);
	await new Promise((resolve) => peerServer.listen(join(directory, `${peerId}.sock`), resolve));
	const agents = await http("GET", "/agents");
	assert.equal(agents.status, 200);
	const list = JSON.parse(agents.text);
	assert.equal(list[0].id, id);
	assert.equal(list[0].status, "busy");
	assert.equal(list[0].model, "claude-opus");
	assert.deepEqual(list.slice(1).map((entry) => entry.id), [peerId]);
	console.log("PASS /agents lists this session first with its merged state");

	const listed = await call("list_agent");
	assert.equal(listed.isError, false);
	assert.equal(listed.value.self, id);
	assert.deepEqual(listed.value.agents.map((entry) => entry.id), [peerId]);
	const sent = await call("text_agent", { ids: [peerId, peerId, id], text: "hi" });
	assert.equal(sent.isError, false);
	assert.deepEqual(sent.value.map((entry) => [entry.id, entry.status]), [[peerId, "accepted"], [id, "rejected"]]);
	const delivered = peerFrames.find((frame) => frame.kind === "text");
	assert.deepEqual(delivered, { kind: "text", from: { id, name: "Audit session" }, text: "hi" });
	assert.equal((await call("text_agent", { ids: [], text: "hi" })).isError, true);
	assert.equal((await call("nope")).isError, true);
	await record({ spare: true });
	const blocked = await call("list_agent");
	assert.equal(blocked.isError, true);
	assert.equal((await http("GET", "/agents")).status, 503, "the local popup follows the owner gate");
	await record();
	console.log("PASS MCP tools route through the owner gate and the peer protocol");

	child.stdin.end();
	assert.equal(await exited, 0, stderr);
	await assert.rejects(stat(join(directory, `${id}.sock`)), { code: "ENOENT" });
	await assert.rejects(stat(statePath), { code: "ENOENT" });
	assert.equal(stderr, "");
	console.log("PASS stdin close shuts the adapter down and removes its sockets");
} catch (error) {
	console.error(stderr);
	throw error;
} finally {
	child.kill();
	for (const server of servers) await new Promise((resolve) => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
	await rm(work, { recursive: true, force: true });
}
