import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";

export const MAX_TEXT_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 128 * 1024;
const TIMEOUT_MS = 3000;
export const AGENT_ID = /^[a-f0-9]{32}$/;

export type AgentInfo = {
	id: string;
	sessionId: string;
	name?: string;
	cwd: string;
	provider?: string;
	model?: string;
	status: "idle" | "busy" | "unavailable";
};

export type Request = { kind: "info" } | { kind: "text"; from: { id: string; name?: string }; text: string };
export type Receipt = { status: "accepted" | "rejected" | "unknown"; reason?: string };
export type Response = { status: "ok"; agent: AgentInfo } | Receipt;

export function socketDirectory(agentDir: string): string {
	const profile = createHash("sha256").update(agentDir).digest("hex").slice(0, 12);
	return `/tmp/pi-agent-text-${process.getuid!()}-${profile}`;
}

export async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
		throw new Error(`Agent text requires a private, user-owned directory: ${path}`);
	}
}

function readFrame(socket: Socket, receive: (value: unknown) => void): void {
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
		} catch {
			socket.destroy(new Error("Invalid agent text frame"));
			return;
		}
		receive(value);
	});
}

export async function listen(path: string, receive: (value: unknown) => Response): Promise<() => Promise<void>> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.setTimeout(TIMEOUT_MS, () => socket.destroy());
		readFrame(socket, (value) => {
			let response: Response;
			try {
				response = receive(value);
			} catch (error) {
				response = { status: "rejected", reason: error instanceof Error ? error.message : String(error) };
			}
			socket.end(JSON.stringify(response) + "\n");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.unref();
	return () => new Promise<void>((resolve, reject) => {
		for (const socket of sockets) socket.destroy();
		server.close((error) => error ? reject(error) : resolve());
	});
}

export function request(directory: string, id: string, message: Request, signal?: AbortSignal): Promise<Response> {
	if (!AGENT_ID.test(id)) return Promise.resolve({ status: "rejected", reason: "Invalid agent ID; use list_agent." });
	return new Promise((resolve) => {
		let sent = false;
		let finished = false;
		const socket = createConnection(join(directory, `${id}.sock`));
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
			const response = value as Response | null;
			if (!response || !["ok", "accepted", "rejected", "unknown"].includes(response.status)
				|| (response.status === "ok" && (!response.agent || response.agent.id !== id))) {
				fail("Invalid acknowledgement.");
				return;
			}
			finish(response);
		});
		socket.once("connect", () => {
			if (finished) return;
			sent = true;
			socket.write(JSON.stringify(message) + "\n");
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}
