import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const windows = process.platform === "win32";
const root = process.env.PI_ROOT ?? (windows
	? join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent")
	: join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent"));
const scratch = await mkdtemp(join(tmpdir(), "pi-agent-text-setup-test-"));
const profile = join(scratch, "profile");
await mkdir(profile);
process.env.PI_CODING_AGENT_DIR = profile;
const { createJiti } = await import(pathToFileURL(join(root, "node_modules/jiti/lib/jiti-static.mjs")).href);
const jiti = createJiti(join(root, "dist/index.js"), {
	alias: { "@earendil-works/pi-coding-agent": join(root, "dist/index.js") },
	moduleCache: false,
});
const { configureClaude } = await jiti.import(fileURLToPath(new URL("../setup-claude.ts", import.meta.url)));

const BUNDLE = fileURLToPath(new URL("../dist/claude-mcp.mjs", import.meta.url));
const MOD = fileURLToPath(new URL("../claude-mod", import.meta.url));
const PROFILE = await realpath(profile);

// A `claude` CLI stand-in: logs each call, and keeps `mcp add`, `add-json` and `remove`
// in $CLAUDE_CONFIG_DIR/.claude.json as the real one does.
const stub = join(scratch, "claude-stub.mjs");
await writeFile(stub, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR;
const file = join(dir, ".claude.json");
appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, hasSettings: existsSync(join(dir, "settings.json")) }) + "\\n");
if (process.env.STUB_FAIL && args.join(" ").startsWith(process.env.STUB_FAIL)) { console.error("stub: " + process.env.STUB_FAIL + " failed"); process.exit(1); }
const read = () => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
if (args[0] === "--version") console.log(process.env.STUB_VERSION + " (Claude Code)");
else if (args[0] === "mcp" && args[1] === "add") {
	const value = read();
	const at = args.indexOf("--");
	if (value.mcpServers?.[args[at - 1]]) { console.error("already exists"); process.exit(1); }
	value.mcpServers = { ...value.mcpServers, [args[at - 1]]: { type: "stdio", command: args[at + 1], args: args.slice(at + 2), env: {} } };
	writeFileSync(file, JSON.stringify(value));
} else if (args[0] === "mcp" && args[1] === "add-json") {
	const value = read();
	if (value.mcpServers?.[args.at(-2)]) { console.error("already exists"); process.exit(1); }
	value.mcpServers = { ...value.mcpServers, [args.at(-2)]: JSON.parse(args.at(-1)) };
	writeFileSync(file, JSON.stringify(value));
	if (process.env.STUB_EDIT_SETTINGS) writeFileSync(join(dir, "settings.json"), process.env.STUB_EDIT_SETTINGS);
} else if (args[0] === "mcp" && args[1] === "remove") {
	const value = read();
	delete value.mcpServers[args.at(-1)];
	writeFileSync(file, JSON.stringify(value));
}
`);

// A node on PATH through a link, as Homebrew's /opt/homebrew/bin/node links into its Cellar.
const bin = join(scratch, "bin");
await mkdir(bin);
const linkedNode = join(bin, windows ? "node.exe" : "node");
if (!windows) await symlink(process.execPath, linkedNode);
const node = windows ? process.execPath : linkedNode;
if (!windows) process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

let checkRegistryFails = false;
const pi = {
	async exec(command, args) {
		// The registry check reads a live Claude's session registry; the adapter's own tests cover it.
		if (args[1] === "--check-registry") return checkRegistryFails
			? { code: 1, stdout: "", stderr: "Cannot verify registry", killed: false }
			: { code: 0, stdout: "Claude session registry verified", stderr: "", killed: false };
		const [file, argv] = command === "claude" ? [process.execPath, [stub, ...args]] : [command, args];
		return new Promise((resolve) => execFile(file, argv, (error, stdout, stderr) =>
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr, killed: !!error?.killed })));
	},
};

let config;
let confirms;
let notes;
let answer;
const ctx = {
	hasUI: true,
	ui: {
		async confirm(title, body) { confirms.push({ title, body }); return answer; },
		notify(message, type) { notes.push({ message, type }); },
	},
};

async function fresh() {
	config = await mkdtemp(join(scratch, "claude-"));
	process.env.CLAUDE_CONFIG_DIR = config;
	process.env.STUB_LOG = join(config, "calls.log");
	process.env.STUB_VERSION = "2.1.296";
	delete process.env.STUB_FAIL;
	delete process.env.STUB_EDIT_SETTINGS;
	checkRegistryFails = false;
	confirms = [];
	notes = [];
	answer = true;
}
const run = (action) => configureClaude(pi, action, ctx);
const calls = async () => (await readFile(process.env.STUB_LOG, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const mutations = async () => (await calls()).filter(({ args }) => args[0] === "mcp");
const registration = async () => JSON.parse(await readFile(join(config, ".claude.json"), "utf8").catch(() => "{}")).mcpServers?.["agent-text"];
const settingsFile = () => join(config, "settings.json");
const settings = async () => JSON.parse(await readFile(settingsFile(), "utf8"));
const owned = (command) => ({ type: "stdio", command, args: [BUNDLE, "--profile", PROFILE], env: {} });
const mode = async (file) => (await stat(file)).mode & 0o777;

try {
	await fresh();
	await run("");
	await run("setup-claude");
	assert.equal(notes.length, 2);
	assert.ok(notes.every(({ message }) => message.includes("/agent-text hire-claude") && message.includes("/agent-text fire-claude")));
	assert.deepEqual(confirms, []);
	assert.equal(await registration(), undefined);
	console.log("PASS unknown and old action names only print help");

	await fresh();
	await run("hire-claude");
	assert.equal(confirms.length, 1);
	assert.match(confirms[0].body, /Add MCP server 'agent-text'/);
	assert.match(confirms[0].body, /Add the mod to env\.CLAUDE_CODE_PLUGIN_DIRS/);
	assert.ok(confirms[0].body.split("\n").length <= 5);
	assert.deepEqual(await registration(), owned(node));
	assert.deepEqual(await settings(), { env: { CLAUDE_CODE_PLUGIN_DIRS: MOD } });
	if (!windows) assert.equal(await mode(settingsFile()), 0o600);
	const added = (await mutations()).find(({ args }) => args[1] === "add-json");
	assert.equal(added.hasSettings, false);
	assert.ok((await calls()).some(({ args }) => args.join(" ") === `plugin validate ${MOD}`));
	console.log("PASS hire-claude registers the PATH node link, adds the MCP server before writing a new 0600 settings.json, and validates the mod");

	confirms = [];
	await run("hire-claude");
	assert.deepEqual(confirms, []);
	assert.match(notes.at(-1).message, /already registered/);
	assert.equal((await mutations()).length, 1);
	console.log("PASS hire-claude is idempotent once registered");

	await fresh();
	await writeFile(join(config, ".claude.json"), JSON.stringify({ mcpServers: { "agent-text": owned("/opt/homebrew/Cellar/node/0.0.0/bin/node") } }));
	await writeFile(settingsFile(), JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: MOD } }));
	await run("hire-claude");
	assert.match(confirms[0].body, /Repair MCP server 'agent-text': run it on .* instead of \/opt\/homebrew\/Cellar/);
	assert.doesNotMatch(confirms[0].body, /Add the mod/);
	assert.deepEqual((await mutations()).map(({ args }) => args[1]), ["remove", "add-json"]);
	assert.deepEqual(await registration(), owned(node));
	console.log("PASS a registration on a stale runtime is offered for repair, not treated as a conflict");

	await fresh();
	const tuned = { ...owned("/opt/homebrew/Cellar/node/0.0.0/bin/node"), env: { NODE_OPTIONS: "--max-old-space-size=512" }, timeout: 5000 };
	await writeFile(join(config, ".claude.json"), JSON.stringify({ mcpServers: { "agent-text": tuned } }));
	await run("hire-claude");
	assert.match(confirms[0].body, /keeping its other options/);
	assert.deepEqual(await registration(), { ...tuned, command: node });
	console.log("PASS a runtime repair keeps the registration's env and other options");

	await fresh();
	const broken = { ...owned("/opt/homebrew/Cellar/node/0.0.0/bin/node"), env: { NODE_OPTIONS: 7 } };
	await writeFile(join(config, ".claude.json"), JSON.stringify({ mcpServers: { "agent-text": broken } }));
	await assert.rejects(run("hire-claude"), /has an invalid env\. It was not changed\./);
	assert.deepEqual(confirms, []);
	assert.deepEqual(await mutations(), []);
	assert.deepEqual(await registration(), broken);
	console.log("PASS a repair refuses a registration whose env it cannot carry over");

	if (!windows) {
		await fresh();
		const versioned = join(scratch, "node", "v1.2.3", "bin");
		await mkdir(versioned, { recursive: true });
		await symlink(process.execPath, join(versioned, "node"));
		const path = process.env.PATH;
		process.env.PATH = `${versioned}${delimiter}${path}`;
		try { await run("hire-claude"); } finally { process.env.PATH = path; }
		assert.match(confirms[0].body, /v1\.2\.3\/bin\/node names a Node version: rerun \/agent-text hire-claude after upgrading Node\./);
		assert.equal((await registration()).command, join(versioned, "node"));
		console.log("PASS a Node path that names a version is registered with a rerun-after-upgrade warning");
	}

	await fresh();
	const foreign = { type: "stdio", command: "node", args: ["/elsewhere/server.mjs"], env: {} };
	await writeFile(join(config, ".claude.json"), JSON.stringify({ mcpServers: { "agent-text": foreign } }));
	await assert.rejects(run("hire-claude"), /different 'agent-text' MCP registration/);
	await assert.rejects(run("fire-claude"), /different 'agent-text' MCP registration/);
	assert.deepEqual(await registration(), foreign);
	assert.deepEqual(await mutations(), []);
	console.log("PASS a foreign registration of the same name is left alone");

	await fresh();
	const alias = join(scratch, `mod-link-${Date.now()}`);
	await symlink(MOD, alias, windows ? "junction" : "dir");
	const other = join(scratch, "other-mod");
	const original = { theme: "dark", env: { KEEP: "1", CLAUDE_CODE_PLUGIN_DIRS: [other, `${alias}/`].join(delimiter) } };
	await writeFile(settingsFile(), JSON.stringify(original));
	if (!windows) await chmod(settingsFile(), 0o640);
	await run("hire-claude");
	assert.doesNotMatch(confirms[0].body, /Add the mod/);
	assert.deepEqual(await settings(), original);
	await run("fire-claude");
	assert.deepEqual(await settings(), { theme: "dark", env: { KEEP: "1", CLAUDE_CODE_PLUGIN_DIRS: other } });
	if (!windows) assert.equal(await mode(settingsFile()), 0o640);
	assert.equal(await registration(), undefined);
	console.log("PASS another spelling of the mod path counts as present; fire-claude removes only it and keeps settings and file mode");

	await fresh();
	await writeFile(settingsFile(), JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: MOD } }));
	answer = false;
	await run("hire-claude");
	answer = true;
	assert.equal(await registration(), undefined);
	await run("hire-claude");
	answer = false;
	await run("fire-claude");
	assert.deepEqual(await registration(), owned(node));
	assert.deepEqual(await settings(), { env: { CLAUDE_CODE_PLUGIN_DIRS: MOD } });
	answer = true;
	await run("fire-claude");
	assert.equal(await registration(), undefined);
	assert.deepEqual(await settings(), { env: {} });
	confirms = [];
	await run("fire-claude");
	assert.deepEqual(confirms, []);
	assert.match(notes.at(-1).message, /No agent-text registration/);
	console.log("PASS a declined confirmation changes nothing; fire-claude removes both parts, then has nothing left to remove");

	await fresh();
	process.env.STUB_FAIL = "mcp add";
	await assert.rejects(run("hire-claude"), /mcp add failed\nRerun \/agent-text hire-claude to complete\./);
	await assert.rejects(stat(settingsFile()), { code: "ENOENT" });
	delete process.env.STUB_FAIL;
	await run("hire-claude");
	assert.deepEqual(await registration(), owned(node));
	assert.deepEqual(await settings(), { env: { CLAUDE_CODE_PLUGIN_DIRS: MOD } });
	console.log("PASS a failed MCP add leaves settings untouched and a rerun completes the install");

	await fresh();
	process.env.STUB_EDIT_SETTINGS = JSON.stringify({ theme: "light" });
	await assert.rejects(run("hire-claude"), /Claude settings changed during setup; they were not changed\.\nRerun \/agent-text hire-claude to complete\./);
	assert.deepEqual(await registration(), owned(node));
	assert.deepEqual(await settings(), { theme: "light" });
	delete process.env.STUB_EDIT_SETTINGS;
	await run("hire-claude");
	assert.equal((await mutations()).length, 1);
	assert.deepEqual(await settings(), { theme: "light", env: { CLAUDE_CODE_PLUGIN_DIRS: MOD } });
	console.log("PASS settings edited during setup are left alone after the MCP add, and a rerun adds only the mod");

	await fresh();
	const confirm = ctx.ui.confirm;
	ctx.ui.confirm = async (title, body) => {
		await writeFile(join(config, ".claude.json"), JSON.stringify({ mcpServers: { "agent-text": { command: "x" } } }));
		return confirm(title, body);
	};
	try { await assert.rejects(run("hire-claude"), /Claude registration changed while confirming; nothing was changed\./); } finally { ctx.ui.confirm = confirm; }
	assert.deepEqual(await mutations(), []);
	await assert.rejects(stat(settingsFile()), { code: "ENOENT" });
	console.log("PASS a registration changed during confirmation stops setup before any change");

	await fresh();
	await run("hire-claude");
	process.env.STUB_FAIL = "mcp remove";
	await assert.rejects(run("fire-claude"), /Rerun \/agent-text fire-claude to complete\./);
	delete process.env.STUB_FAIL;
	await run("fire-claude");
	assert.equal(await registration(), undefined);
	console.log("PASS a failed removal says to rerun, and the rerun completes it");

	for (const [setup, pattern] of [
		[() => { process.env.STUB_VERSION = "2.1.276"; }, /2\.1\.277 or later/],
		[() => { process.env.STUB_FAIL = "plugin validate"; }, /plugin validate failed/],
		[() => { checkRegistryFails = true; }, /Cannot verify registry/],
	]) {
		await fresh();
		setup();
		await assert.rejects(run("hire-claude"), pattern);
		assert.deepEqual(confirms, []);
		assert.deepEqual(await mutations(), []);
		await assert.rejects(stat(settingsFile()), { code: "ENOENT" });
	}
	console.log("PASS an old Claude, an invalid mod, or a failed registry check stops setup before any change");

	await fresh();
	await writeFile(settingsFile(), "{ not json");
	await assert.rejects(run("hire-claude"), /Cannot parse Claude settings/);
	await writeFile(settingsFile(), JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: 7 } }));
	await assert.rejects(run("hire-claude"), /Invalid CLAUDE_CODE_PLUGIN_DIRS/);
	await writeFile(settingsFile(), "{}");
	await writeFile(join(config, ".claude.json"), JSON.stringify({ mcpServers: { "agent-text": "x" } }));
	await assert.rejects(run("hire-claude"), /Invalid 'agent-text' MCP registration/);
	await writeFile(join(config, ".claude.json"), "{ not json");
	await assert.rejects(run("hire-claude"), /Cannot parse Claude MCP configuration/);
	assert.deepEqual(await mutations(), []);
	console.log("PASS malformed Claude files are reported as such and left alone");

	await fresh();
	await assert.rejects(configureClaude(pi, "hire-claude", { ...ctx, hasUI: false }), /interactive confirmation/);
	console.log("PASS setup refuses to run without a confirmation UI");
} finally {
	await rm(scratch, { recursive: true, force: true });
}
