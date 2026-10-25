import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

// PI_ROOT can point at another installed/built Pi version. No install or model access is needed.
const packageName = "@earendil-works/pi-coding-agent";
function findPi() {
	if (process.env.PI_ROOT) return resolve(process.env.PI_ROOT);
	try {
		return dirname(dirname(fileURLToPath(import.meta.resolve(packageName))));
	} catch {
		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		// `npm test --prefix ...` exports its local prefix; don't mistake it for Pi's global install.
		const env = Object.fromEntries(Object.entries(process.env)
			.filter(([key]) => key.toLowerCase() !== "npm_config_prefix"));
		return join(execFileSync(npm, ["root", "-g"], { encoding: "utf8", env }).trim(), packageName);
	}
}
export const piRoot = findPi();
const requirePi = createRequire(join(piRoot, "package.json"));
const importFile = (path) => import(pathToFileURL(path).href);
export const sdk = await importFile(join(piRoot, "dist/index.js"));
export const tui = await importFile(requirePi.resolve("@earendil-works/pi-tui"));
const typebox = await importFile(requirePi.resolve("typebox"));
const { createJiti } = await importFile(requirePi.resolve("jiti"));
const { loadExtensions } = await importFile(join(piRoot, "dist/core/extensions/loader.js"));
export const { theme } = await importFile(join(piRoot, "dist/modes/interactive/theme/theme.js"));
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const args = { command: "printf example", description: "Inspect implementation" };

export const text = (component, width = 80) => component.render(width).map(stripVTControlCharacters).join("\n");
export function click(component, match) {
	const lines = component.render(80);
	const y = lines.findIndex((line) => match.test(stripVTControlCharacters(line)));
	assert(y >= 0, `Click target not found: ${match}\n${text(component)}`);
	const result = component.handleMouse({
		type: "click", button: "left", x: 3, y, screenX: 3, screenY: y,
		width: 80, height: lines.length, shift: false, alt: false, ctrl: false,
	});
	assert(result?.handled, "Click escaped to Pi's binary expand/collapse handler");
}

export async function harness(t, mutate) {
	let expanded = false;
	let tool;
	let base;
	let handlers;
	const rows = [];
	const rendererErrors = [];
	const ctx = { cwd: process.cwd(), mode: "tui", ui: { getToolsExpanded: () => expanded } };
	if (!mutate) {
		// Exercise Pi's real extension loader, not just our registration mock.
		const loaded = await loadExtensions([extensionPath], ctx.cwd);
		assert.deepEqual(loaded.errors, [], "Pi could not load shorter-ui");
		loaded.runtime.getSettings = () => ({});
		const extension = loaded.extensions[0];
		handlers = extension.handlers;
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
		tool = extension.tools.get("bash")?.definition;
	} else {
		// Substitute only the upstream factory. Production extension code stays unchanged.
		const jiti = createJiti(import.meta.url, {
			moduleCache: false, fsCache: false, tryNative: false,
			virtualModules: {
				[packageName]: {
					...sdk,
					createBashToolDefinition(cwd, options) {
						base = mutate(sdk.createBashToolDefinition(cwd, options));
						return base;
					},
				},
				"@earendil-works/pi-tui": tui,
				typebox,
			},
		});
		const factory = await jiti.import(extensionPath, { default: true });
		handlers = new Map();
		factory({
			on(name, handler) {
				if (!handlers.has(name)) handlers.set(name, []);
				handlers.get(name).push(handler);
			},
			getSettings: () => ({}),
			registerTool: (definition) => { tool = definition; },
		});
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
	}
	assert(tool, "Extension did not register bash");
	async function emit(type) {
		for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx);
	}
	t.after(async () => {
		await emit("session_shutdown");
		assert.deepEqual(rendererErrors, [], "Pi swallowed renderer failures and substituted generic output");
	});
	const checkedTool = { ...tool };
	for (const name of ["renderCall", "renderResult"]) {
		checkedTool[name] = (...input) => {
			try { return tool[name](...input); }
			catch (error) { rendererErrors.push(error); throw error; }
		};
	}
	return {
		tool, base, emit,
		row(id, definition = checkedTool, options = {}) {
			const row = new sdk.ToolExecutionComponent("bash", id, args,
				{ showImages: false, ...options }, definition, { requestRender() {} }, ctx.cwd);
			row.setExpanded(expanded);
			rows.push(row);
			return row;
		},
		expand(value) {
			expanded = value;
			for (const row of rows) row.setExpanded(value);
		},
		context(id) {
			return {
				args, toolCallId: id, state: {}, cwd: ctx.cwd, invalidate() {}, lastComponent: undefined,
				executionStarted: false, argsComplete: true, isPartial: false, expanded,
				showImages: false, isError: false, durationMs: 125, outputPad: 1,
			};
		},
	};
}
