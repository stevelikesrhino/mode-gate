import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const NAME = "agent-text";
const BUNDLE = fileURLToPath(new URL("./dist/claude-mcp.mjs", import.meta.url));
const MOD = fileURLToPath(new URL("./claude-mod", import.meta.url));
const PLUGIN_DIRS = "CLAUDE_CODE_PLUGIN_DIRS";

type Registration = { type?: string; command?: string; args?: string[]; env?: Record<string, string> };
type Settings = { raw?: string; value: Record<string, any>; dirs: string[] };

export async function configureClaude(pi: ExtensionAPI, action: string, ctx: ExtensionCommandContext): Promise<void> {
	if (action !== "setup-claude" && action !== "uninstall-claude") {
		ctx.ui.notify("/agent-text setup-claude — register peer messaging in Claude Code\n/agent-text uninstall-claude — remove this registration\nRestart Claude after either change. No special launch flags are needed.", "info");
		return;
	}
	if (!ctx.hasUI) throw new Error("Claude setup requires an interactive confirmation.");

	const profile = await realpath(getAgentDir());
	const config = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
	const settingsFile = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
	async function registered(): Promise<Registration | undefined> {
		try {
			const value = JSON.parse(await readFile(config, "utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration.");
			const servers = value.mcpServers;
			if (servers === undefined) return;
			if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Invalid MCP configuration.");
			if (!Object.hasOwn(servers, NAME)) return;
			const registration = servers[NAME];
			if (!registration || typeof registration !== "object" || Array.isArray(registration)) throw new Error("Invalid MCP registration.");
			return registration;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error(`Cannot read Claude MCP configuration: ${config}`);
		}
	}
	async function settings(): Promise<Settings> {
		let raw: string;
		try { raw = await readFile(settingsFile, "utf8"); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: {}, dirs: [] };
			throw new Error(`Cannot read Claude settings: ${settingsFile}`);
		}
		let value: any;
		try { value = JSON.parse(raw); } catch { throw new Error(`Cannot parse Claude settings: ${settingsFile}`); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Claude settings: ${settingsFile}`);
		const env = value.env;
		if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env))) throw new Error(`Invalid env in Claude settings: ${settingsFile}`);
		const list = env?.[PLUGIN_DIRS];
		if (list !== undefined && typeof list !== "string") throw new Error(`Invalid ${PLUGIN_DIRS} in Claude settings: ${settingsFile}`);
		return { raw, value, dirs: list ? list.split(delimiter).filter(Boolean) : [] };
	}
	async function writeDirs(before: Settings, dirs: string[]): Promise<void> {
		if ((await settings()).raw !== before.raw) throw new Error("Claude settings changed while confirming; nothing was changed.");
		const env = { ...before.value.env };
		if (dirs.length) env[PLUGIN_DIRS] = dirs.join(delimiter); else delete env[PLUGIN_DIRS];
		const target = await realpath(settingsFile).catch(() => settingsFile);
		const temp = `${target}.${process.pid}.tmp`;
		await mkdir(dirname(target), { recursive: true });
		await writeFile(temp, JSON.stringify({ ...before.value, env }, null, 2) + "\n");
		await rename(temp, target);
	}
	async function run(command: string, args: string[]): Promise<string> {
		const result = await pi.exec(command, args, { timeout: 15_000 });
		if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || `${command} failed. Check that it is installed and on PATH.`);
		return result.stdout.trim();
	}
	function owned(value: Registration | undefined): boolean {
		return !!value && (value.type === undefined || value.type === "stdio")
			&& Array.isArray(value.args) && value.args.length === 3
			&& value.args[0] === BUNDLE && value.args[1] === "--profile" && value.args[2] === profile;
	}

	const existing = await registered();
	if (existing && !owned(existing)) {
		throw new Error(`A different '${NAME}' MCP registration already exists in ${config}. It was not changed. Resolve that name conflict in Claude before running setup.`);
	}
	const before = await settings();
	const modded = before.dirs.includes(MOD);
	if (action === "uninstall-claude") {
		if (!existing && !modded) { ctx.ui.notify("No agent-text user-scope registration or mod entry to remove.", "info"); return; }
		if (!await ctx.ui.confirm("Remove Claude peer messaging?", [
			existing && `Remove only '${NAME}' from ${config}?`,
			modded && `Remove only ${MOD} from env.${PLUGIN_DIRS} in ${settingsFile}?`,
			"Pi-to-Pi messaging is unaffected. Restart Claude to disconnect its running adapters.",
		].filter(Boolean).join("\n"))) return;
		if (JSON.stringify(await registered()) !== JSON.stringify(existing)) throw new Error("Claude registration changed while confirming; nothing was removed.");
		if (modded) await writeDirs(before, before.dirs.filter((dir) => dir !== MOD));
		if (existing) await run("claude", ["mcp", "remove", "--scope", "user", NAME]);
		ctx.ui.notify("Claude registration removed. Restart Claude to disconnect; Pi messaging is unchanged.", "info");
		return;
	}

	await access(BUNDLE);
	await access(join(MOD, ".claude-plugin", "plugin.json"));
	const node = await run("node", ["-p", "process.execPath"]);
	await run(node, [BUNDLE, "--check"]);
	const version = await run("claude", ["--version"]);
	const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version);
	if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 277)))) {
		throw new Error("Claude Code 2.1.277 or later is required for this adapter. Update Claude before setup.");
	}
	await run(node, [BUNDLE, "--check-registry", match[0]]);
	if (existing && modded) {
		ctx.ui.notify("Claude's session registry passed the compatibility check. This profile's agent-text adapter and mod are already registered. Restart Claude, then use /mcp to check agent-text. No channel flags are needed.", "info");
		return;
	}
	if (!await ctx.ui.confirm("Enable Claude peer messaging?", [
		!existing && `Add '${NAME}' to ${config} (user scope, all projects)?`,
		!modded && `Add the mod to env.${PLUGIN_DIRS} in ${settingsFile}? Other settings and plugin paths are kept.`,
		`Runtime: ${node}`,
		`Adapter: ${BUNDLE}`,
		`Mod: ${MOD}`,
		`Pi profile: ${profile}`,
		"Connected Pi and Claude agents in this profile can discover and message each other, starting model turns. Your existing Claude permissions still apply.",
		"Claude's session registry passed the compatibility check. Each adapter reads only its owner's record to exclude spare workers and parked launchers; missing or incompatible records disable messaging. Live detached sessions remain discoverable.",
		"The mod's hooks push this session's state to its adapter over a private socket. No channel flags, background service, or Claude peer registry changes. Uninstall with /agent-text uninstall-claude.",
	].filter(Boolean).join("\n"))) return;
	if (JSON.stringify(await registered()) !== JSON.stringify(existing)) throw new Error("Claude registration changed while confirming; nothing was overwritten.");
	if (!modded) await writeDirs(before, [...before.dirs, MOD]);
	if (!existing) await run("claude", ["mcp", "add", "--scope", "user", "--transport", "stdio", NAME, "--", node, BUNDLE, "--profile", profile]);
	ctx.ui.notify("Claude peer messaging registered. Restart Claude normally and check /mcp. Ask it to use agent-text's list_agent and text_agent; its native /list-agents is separate. Disable agent-text in Claude's /mcp to disconnect it.", "info");
}
