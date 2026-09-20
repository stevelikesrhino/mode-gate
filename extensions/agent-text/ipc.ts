import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { privateWindowsDirectory } from "./windows.ts";

const WINDOWS = process.platform === "win32";

export const MAX_TEXT_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = (WINDOWS ? 192 : 128) * 1024;
const TIMEOUT_MS = 3000;
export const AGENT_ID = /^[a-f0-9]{8}$/;

export type AgentInfo = {
	id: string;
	sessionId: string;
	name?: string;
	cwd: string;
	provider?: string;
	model?: string;
	status: "idle" | "busy" | "unavailable" | "unknown";
	kind?: "pi" | "claude";
};

export type Request = { kind: "info" } | { kind: "text"; from: { id: string; name?: string }; text: string };
export type Receipt = { status: "accepted" | "rejected" | "unknown"; reason?: string };
export type Response = { status: "ok"; agent: AgentInfo } | Receipt;

export function socketDirectory(agentDir: string): string {
	if (WINDOWS) return join(agentDir, "agent-text", "sockets");
	const profile = createHash("sha256").update(agentDir).digest("hex").slice(0, 12);
	return `/tmp/pi-agent-text-${process.getuid!()}-${profile}`;
}

export async function privateDirectory(path: string): Promise<void> {
	if (WINDOWS) return privateWindowsDirectory(path);
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
		throw new Error(`Agent text requires a private, user-owned directory: ${path}`);
	}
}

function frame(value: unknown, key?: Buffer): string {
	const text = JSON.stringify(value);
	if (!key) return text + "\n";
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
	return JSON.stringify(Buffer.concat([nonce, cipher.getAuthTag(), data]).toString("base64")) + "\n";
}

function readFrame(socket: Socket, receive: (value: unknown) => void, key?: Buffer): void {
	let buffer = "";
	let bytes = 0;
	let finished = false;
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		if (finished) return;
		bytes += Buffer.byteLength(chunk);
		if (bytes > MAX_FRAME_BYTES) {
			socket.destroy(new Error("Agent text frame too large"));
			return;
		}
		buffer += chunk;
		const end = buffer.indexOf("\n");
		if (end < 0) return;
		finished = true;
		let value: unknown;
		try {
			value = JSON.parse(buffer.slice(0, end));
			if (key) {
				if (typeof value !== "string") throw new Error("Unauthenticated frame");
				const data = Buffer.from(value, "base64");
				const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
				decipher.setAuthTag(data.subarray(12, 28));
				value = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"));
			}
		} catch {
			socket.destroy(new Error("Invalid agent text frame"));
			return;
		}
		receive(value);
	});
}

function parseResponse(value: unknown, id: string): Response | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const response = value as Response;
	if (response.status === "ok") {
		const agent = response.agent;
		if (!agent || agent.id !== id
			|| typeof agent.sessionId !== "string" || !agent.sessionId || agent.sessionId.length > 128
			|| typeof agent.cwd !== "string" || agent.cwd.length > 300
			|| !["idle", "busy", "unavailable", "unknown"].includes(agent.status)
			|| (agent.kind !== undefined && agent.kind !== "pi" && agent.kind !== "claude")) return;
		for (const [field, limit] of [[agent.name, 120], [agent.provider, 80], [agent.model, 120]] as const) {
			if (field !== undefined && (typeof field !== "string" || field.length > limit)) return;
		}
		return { status: "ok", agent: {
			id, sessionId: agent.sessionId, cwd: agent.cwd, name: agent.name,
			provider: agent.provider, model: agent.model, status: agent.status, kind: agent.kind,
		} };
	}
	if (!["accepted", "rejected", "unknown"].includes(response.status)
		|| (response.reason !== undefined && (typeof response.reason !== "string" || response.reason.length > 2048))) return;
	return { status: response.status, reason: response.reason };
}

export async function listen(path: string, receive: (value: unknown) => Response | Promise<Response>): Promise<() => Promise<void>> {
	const key = WINDOWS ? randomBytes(32) : undefined;
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		const timer = setTimeout(() => socket.destroy(), TIMEOUT_MS);
		socket.on("close", () => { clearTimeout(timer); sockets.delete(socket); });
		socket.on("error", () => socket.destroy());
		readFrame(socket, (value) => {
			void (async () => {
				let response: Response;
				try {
					response = await receive(value);
				} catch (error) {
					response = { status: "rejected", reason: error instanceof Error ? error.message : String(error) };
				}
				if (!socket.destroyed) socket.end(frame(response, key));
			})().catch(() => socket.destroy());
		}, key);
	});
	server.maxConnections = 128;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(WINDOWS ? { host: "127.0.0.1", port: 0 } : { path }, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const close = () => new Promise<void>((resolve, reject) => {
		for (const socket of sockets) socket.destroy();
		server.close((error) => error ? reject(error) : resolve());
	});
	if (key) {
		const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify({ port: (server.address() as AddressInfo).port, key: key.toString("hex") }), { flag: "wx" });
			await link(temporary, path);
			await rm(temporary);
		} catch (error) {
			await close();
			await rm(temporary, { force: true });
			throw error;
		}
	}
	server.unref();
	return async () => {
		try {
			await close();
		} finally {
			if (WINDOWS) await rm(path, { force: true });
		}
	};
}

export async function request(directory: string, id: string, message: Request, signal?: AbortSignal): Promise<Response> {
	if (!AGENT_ID.test(id)) return { status: "rejected", reason: "Invalid agent ID; use list_agent." };
	const path = join(directory, `${id}.sock`);
	let key: Buffer | undefined;
	let port = 0;
	if (WINDOWS) {
		try {
			const record = JSON.parse(await readFile(path, "utf8"));
			if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535
				|| typeof record.key !== "string" || !/^[a-f0-9]{64}$/.test(record.key)) {
				throw new Error("Invalid agent registration");
			}
			port = record.port;
			key = Buffer.from(record.key, "hex");
		} catch (error) {
			return { status: "rejected", reason: `Unavailable: ${(error as NodeJS.ErrnoException).code ?? String(error)} (offline, stopped, or stale ID).` };
		}
	}
	if (signal?.aborted) return { status: "rejected", reason: "Cancelled before sending." };
	return new Promise((resolve) => {
		let sent = false;
		let finished = false;
		const socket = createConnection(WINDOWS ? { host: "127.0.0.1", port } : { path });
		const finish = (response: Response) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			socket.destroy();
			resolve(response);
		};
		const fail = (reason: string) => finish({ status: sent ? "unknown" : "rejected", reason });
		const abort = () => fail(sent ? "Delivery unknown: cancelled after sending; do not automatically retry." : "Cancelled before sending.");
		const timer = setTimeout(() => fail(sent
			? "Delivery unknown: no acknowledgement; do not automatically retry."
			: "Unavailable: connection timed out."), TIMEOUT_MS);
		socket.on("error", (error: NodeJS.ErrnoException) => fail(sent
			? `Delivery unknown: ${error.code ?? error.message}; do not automatically retry.`
			: `Unavailable: ${error.code ?? error.message} (offline, stopped, or stale ID).`));
		socket.on("close", () => fail("Connection closed without acknowledgement."));
		readFrame(socket, (value) => {
			const response = parseResponse(value, id);
			if (!response) {
				fail("Invalid acknowledgement.");
				return;
			}
			finish(response);
		}, key);
		socket.once("connect", () => {
			if (finished) return;
			sent = true;
			socket.write(frame(message, key));
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}
