import { constants } from "node:fs";
import { open, readFile, readdir, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type OwnerRecord = {
	pid: number;
	version: string;
	kind: "interactive" | "bg";
	jobId?: string;
	messagingSocketPath: string;
	spare?: boolean;
	parkedJobId?: string;
};

function registryDirectory(): string {
	return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "sessions");
}

async function readOwner(pid: number): Promise<OwnerRecord> {
	const record = JSON.parse(await readFile(join(registryDirectory(), `${pid}.json`), "utf8"));
	if (!record || record.pid !== pid
		|| typeof record.version !== "string" || !/^\d+\.\d+\.\d+$/.test(record.version)
		|| (record.kind !== "interactive" && record.kind !== "bg")
		|| typeof record.messagingSocketPath !== "string" || !record.messagingSocketPath
		|| (record.spare !== undefined && typeof record.spare !== "boolean")
		|| (record.parkedJobId !== undefined && (typeof record.parkedJobId !== "string" || !record.parkedJobId))) {
		throw new Error("Unrecognized Claude session record.");
	}
	process.kill(pid, 0);
	return record;
}

export async function ownerInfo(pid: number, inbox: string): Promise<{ reason?: string; jobId?: string }> {
	try {
		const record = await readOwner(pid);
		if (record.messagingSocketPath !== inbox) return { reason: "Claude owner record does not match this adapter's inbox." };
		if (record.spare === true || record.parkedJobId !== undefined) return { reason: "Claude owner is a spare worker or parked launcher." };
		return { jobId: record.kind === "bg" ? record.jobId : undefined };
	} catch {
		return { reason: "Claude owner record is missing, unreadable, or incompatible. Run /agent-text setup-claude in Pi to check compatibility." };
	}
}

export async function jobModel(jobId: unknown): Promise<string | undefined> {
	if (typeof jobId !== "string" || !/^[a-f0-9]{8}$/.test(jobId)) return;
	let file: FileHandle | undefined;
	try {
		const openFlags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
		file = await open(join(registryDirectory(), "..", "jobs", jobId, "state.json"), openFlags);
		const limit = 64 * 1024;
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > limit) return;
		const buffer = Buffer.alloc(limit + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		if (bytesRead > limit) return;
		const flags = JSON.parse(buffer.toString("utf8", 0, bytesRead))?.respawnFlags;
		if (!Array.isArray(flags) || !flags.every((flag) => typeof flag === "string")) return;
		let model: string | undefined;
		for (let i = 0; i < flags.length && flags[i] !== "--"; i++) {
			const flag = flags[i];
			let value: string | undefined;
			if (flag === "--model" || flag === "-m") value = flags[++i];
			else if (flag.startsWith("--model=") || flag.startsWith("-m=")) value = flag.slice(flag.indexOf("=") + 1);
			else continue;
			if (!value || value.length > 120 || value.startsWith("-") || /[\s\x00-\x1f\x7f-\x9f]/.test(value)) return;
			model = value;
		}
		return model === "default" ? undefined : model;
	} catch {
		// Optional metadata must not hide a reachable agent or block messaging.
	} finally {
		await file?.close().catch(() => {});
	}
}

export async function verifyRegistry(version: string): Promise<void> {
	let files: string[];
	try {
		files = await readdir(registryDirectory());
	} catch {
		throw new Error("Cannot read Claude's session registry. Start Claude normally (not --bare), leave it running, then retry /agent-text setup-claude.");
	}
	for (const file of files) {
		if (!/^[1-9]\d*\.json$/.test(file)) continue;
		const pid = Number(file.slice(0, -5));
		if (!Number.isSafeInteger(pid)) continue;
		try {
			const record = await readOwner(pid);
			if (record.version === version) return;
		} catch {
			// Stale or incompatible records cannot establish compatibility.
		}
	}
	throw new Error(`Cannot verify Claude ${version}'s session registry and messaging fields. Start that version normally (not --bare), leave it running, then retry /agent-text setup-claude. If it is already running, this adapter may need an update.`);
}
