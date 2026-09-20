import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type OwnerRecord = {
	pid: number;
	version: string;
	kind: "interactive" | "bg";
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

export async function ownerUnavailable(pid: number, inbox: string): Promise<string | undefined> {
	try {
		const record = await readOwner(pid);
		if (record.messagingSocketPath !== inbox) return "Claude owner record does not match this adapter's inbox.";
		if (record.spare === true || record.parkedJobId !== undefined) return "Claude owner is a spare worker or parked launcher.";
	} catch {
		return "Claude owner record is missing, unreadable, or incompatible. Run /agent-text setup-claude in Pi to check compatibility.";
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
