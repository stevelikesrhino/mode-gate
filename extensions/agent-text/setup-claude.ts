import { access, chmod, constants, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const NAME = "agent-text";
const BUNDLE = fileURLToPath(new URL("./dist/claude-mcp.mjs", import.meta.url));
const MOD = fileURLToPath(new URL("./claude-mod", import.meta.url));
const PLUGIN_DIRS = "CLAUDE_CODE_PLUGIN_DIRS";

type Registration = { type?: string; command?: string; args?: string[]; env?: Record<string, string> };
type Settings = { raw?: string; mode?: number; value: Record<string, any>; dirs: string[] };

// Claude expands `~` in plugin paths; spellings and links of one folder compare equal.
async function normalize(dir: string): Promise<string> {
	const path = resolve(dir.replace(/^~(?=$|[\\/])/, homedir()));
	const real = await realpath(path).catch(() => path);
	return process.platform === "win32" ? real.toLowerCase() : real;
}

// The PATH entry, not its target: a versioned install directory (Homebrew's
// Cellar) is removed on upgrade while the PATH link stays.
async function findNode(): Promise<string> {
	const name = process.platform === "win32" ? "node.exe" : "node";
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!isAbsolute(dir)) continue;
		const path = join(dir, name);
		if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
	}
	throw new Error("Node.js was not found on PATH.");
}

export async function configureClaude(pi: ExtensionAPI, action: string, ctx: ExtensionCommandContext): Promise<void> {
	if (action !== "hire-claude" && action !== "fire-claude") {
		ctx.ui.notify("/agent-text hire-claude — register peer messaging in Claude Code\n/agent-text fire-claude — remove this registration\nRestart Claude after either change.", "info");
		return;
	}
	if (!ctx.hasUI) throw new Error("Claude setup requires an interactive confirmation.");

	const profile = await realpath(getAgentDir());
	const config = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
	const settingsFile = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
	async function registered(): Promise<Registration | undefined> {
		let raw: string;
		try { raw = await readFile(config, "utf8"); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error(`Cannot read Claude MCP configuration ${config}: ${(error as Error).message}`);
		}
		let value: any;
		try { value = JSON.parse(raw); } catch { throw new Error(`Cannot parse Claude MCP configuration: ${config}`); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Claude MCP configuration: ${config}`);
		const servers = value.mcpServers;
		if (servers === undefined) return;
		if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error(`Invalid mcpServers in ${config}`);
		if (!Object.hasOwn(servers, NAME)) return;
		const registration = servers[NAME];
		if (!registration || typeof registration !== "object" || Array.isArray(registration)) throw new Error(`Invalid '${NAME}' MCP registration in ${config}`);
		return registration;
	}
	async function settings(): Promise<Settings> {
		let raw: string;
		let mode: number;
		try {
			raw = await readFile(settingsFile, "utf8");
			mode = (await stat(settingsFile)).mode & 0o777;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: {}, dirs: [] };
			throw new Error(`Cannot read Claude settings ${settingsFile}: ${(error as Error).message}`);
		}
		let value: any;
		try { value = JSON.parse(raw); } catch { throw new Error(`Cannot parse Claude settings: ${settingsFile}`); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Claude settings: ${settingsFile}`);
		const env = value.env;
		if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env))) throw new Error(`Invalid env in Claude settings: ${settingsFile}`);
		const list = env?.[PLUGIN_DIRS];
		if (list !== undefined && typeof list !== "string") throw new Error(`Invalid ${PLUGIN_DIRS} in Claude settings: ${settingsFile}`);
		return { raw, mode, value, dirs: list ? list.split(delimiter).filter(Boolean) : [] };
	}
	async function writeDirs(before: Settings, dirs: string[]): Promise<void> {
		if ((await settings()).raw !== before.raw) throw new Error("Claude settings changed during setup; they were not changed.");
		const env = { ...before.value.env };
		if (dirs.length) env[PLUGIN_DIRS] = dirs.join(delimiter); else delete env[PLUGIN_DIRS];
		const target = await realpath(settingsFile).catch(() => settingsFile);
		const temp = `${target}.${process.pid}.tmp`;
		await mkdir(dirname(target), { recursive: true });
		await writeFile(temp, JSON.stringify({ ...before.value, env }, null, 2) + "\n", { mode: 0o600 });
		await chmod(temp, before.mode ?? 0o600);
		await rename(temp, target);
	}
	async function run(command: string, args: string[]): Promise<string> {
		const result = await pi.exec(command, args, { timeout: 15_000 });
		if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || `${command} failed. Check that it is installed and on PATH.`);
		return result.stdout.trim();
	}
	// Owned: this adapter for this profile, whatever runtime it was registered with.
	function owned(value: Registration | undefined): boolean {
		return !!value && (value.type === undefined || value.type === "stdio")
			&& Array.isArray(value.args) && value.args.length === 3
			&& value.args[0] === BUNDLE && value.args[1] === "--profile" && value.args[2] === profile;
	}
	// A step after another succeeded leaves a partial install; rerunning completes it.
	async function apply(steps: () => Promise<void>): Promise<void> {
		try { await steps(); } catch (error) {
			throw new Error(`${(error as Error).message}\nRerun /agent-text ${action} to complete.`);
		}
	}

	const existing = await registered();
	if (existing && !owned(existing)) {
		throw new Error(`A different '${NAME}' MCP registration already exists in ${config}. It was not changed. Resolve that name conflict in Claude first.`);
	}
	const before = await settings();
	const mod = await normalize(MOD);
	const entries = await Promise.all(before.dirs.map(normalize));
	const modded = entries.includes(mod);
	if (action === "fire-claude") {
		if (!existing && !modded) { ctx.ui.notify("No agent-text registration or mod entry to remove.", "info"); return; }
		if (!await ctx.ui.confirm("Remove Claude peer messaging?", [
			existing && `Remove MCP server '${NAME}' from ${config}.`,
			modded && `Remove the mod from env.${PLUGIN_DIRS} in ${settingsFile}.`,
			"Pi-to-Pi messaging is unaffected. Restart Claude afterward.",
		].filter(Boolean).join("\n"))) return;
		if (JSON.stringify(await registered()) !== JSON.stringify(existing)) throw new Error("Claude registration changed while confirming; nothing was removed.");
		await apply(async () => {
			if (existing) await run("claude", ["mcp", "remove", "--scope", "user", NAME]);
			if (modded) await writeDirs(before, before.dirs.filter((_, index) => entries[index] !== mod));
		});
		ctx.ui.notify("Claude peer messaging removed. Restart Claude to disconnect; Pi messaging is unchanged.", "info");
		return;
	}

	await access(BUNDLE);
	await access(join(MOD, ".claude-plugin", "plugin.json"));
	const node = await findNode();
	await run(node, [BUNDLE, "--check"]);
	const version = await run("claude", ["--version"]);
	const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version);
	if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 277)))) {
		throw new Error("Claude Code 2.1.277 or later is required for this adapter. Update Claude before setup.");
	}
	await run(node, [BUNDLE, "--check-registry", match[0]]);
	await run("claude", ["plugin", "validate", MOD]);
	const isCurrent = existing?.command === node;
	const env = existing?.env ?? {};
	if (!isCurrent && (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((value) => typeof value !== "string"))) {
		throw new Error(`The '${NAME}' MCP registration in ${config} has an invalid env. It was not changed.`);
	}
	if (isCurrent && modded) {
		ctx.ui.notify("Compatibility checks passed; agent-text is already registered in Claude. Restart Claude, then check /mcp and run /agent-text there.", "info");
		return;
	}
	if (!await ctx.ui.confirm("Enable Claude peer messaging?", [
		!existing && `Add MCP server '${NAME}' to ${config} (user scope, all projects).`,
		existing && !isCurrent && `Repair MCP server '${NAME}': run it on ${node} instead of ${existing.command ?? "an unknown runtime"}, keeping its other options.`,
		!modded && `Add the mod to env.${PLUGIN_DIRS} in ${settingsFile}; other settings are kept.`,
		`Adapter: ${BUNDLE} for Pi profile ${profile}.`,
		/\d+\.\d+\.\d+/.test(node) && `${node} names a Node version: rerun /agent-text hire-claude after upgrading Node.`,
		"Connected Pi and Claude agents in this profile can then message each other, starting model turns. Claude's permissions still apply.",
	].filter(Boolean).join("\n"))) return;
	if (JSON.stringify(await registered()) !== JSON.stringify(existing)) throw new Error("Claude registration changed while confirming; nothing was changed.");
	await apply(async () => {
		if (!isCurrent) {
			if (existing) await run("claude", ["mcp", "remove", "--scope", "user", NAME]);
			// The whole registration as JSON: a repair keeps its env and other options.
			await run("claude", ["mcp", "add-json", "--scope", "user", NAME, JSON.stringify({ ...existing, type: "stdio", command: node, args: [BUNDLE, "--profile", profile], env })]);
		}
		if (!modded) await writeDirs(before, [...before.dirs, MOD]);
	});
	ctx.ui.notify("Claude peer messaging registered. Restart Claude, check /mcp for agent-text, and run /agent-text there to list agents. Use agent-text's list_agent and text_agent, not Claude's native /list-agents.", "info");
}
