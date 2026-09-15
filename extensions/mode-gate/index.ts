/**
 * Mode Gate Extension
 *
 * Three-mode permission system:
 * - watched: scoped content approvals; review execution and destructive actions
 * - yolo: no prompts, full access
 * - explore: read-only, no edit/write, bash allowlisted
 *
 * Shift+Tab cycles available modes. /mode to pick or /mode <name> to switch directly.
 * Starts in watched mode.
 */

import { FooterComponent, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { analyzeCommand, analyzeFile, canonicalPath, exists, inside, Permissions, toolPath, type Analysis } from "./policy.js";

type Mode = "watched" | "yolo" | "explore";

const DEFAULT_MODE: Mode = "watched";

const MODE_LABELS: Record<Mode, string> = {
	watched: "watched",
	yolo: "yolo",
	explore: "explore",
};

const MODE_DESCRIPTIONS: Record<Mode, string> = {
	watched: "scoped approvals for changes & execution",
	yolo: "no prompts, full access",
	explore: "read-only, safe bash only",
};

const MODE_COLORS: Record<Mode, "accent" | "warning" | "success"> = {
	watched: "accent",
	yolo: "warning",
	explore: "success",
};

interface ModeGateSettings {
	exploreAvailable: boolean;
}

const DEFAULT_MODE_GATE_SETTINGS: ModeGateSettings = {
	exploreAvailable: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, key: string, source: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`Invalid modeGate.${key} in ${source}: expected a boolean.`);
	}
	return value;
}

function loadModeGateSettingsFile(path: string): Partial<ModeGateSettings> {
	if (!existsSync(path)) return {};

	const parsed = JSON.parse(readFileSync(path, "utf-8"));
	if (!isRecord(parsed) || parsed.modeGate === undefined) return {};
	if (!isRecord(parsed.modeGate)) {
		throw new Error(`Invalid modeGate settings in ${path}: expected an object.`);
	}

	const raw = parsed.modeGate;
	const settings: Partial<ModeGateSettings> = {};
	if (raw.exploreAvailable !== undefined) settings.exploreAvailable = readBoolean(raw.exploreAvailable, "exploreAvailable", path);
	return settings;
}

function loadModeGateSettings(cwd = process.cwd()): ModeGateSettings {
	return {
		...DEFAULT_MODE_GATE_SETTINGS,
		...loadModeGateSettingsFile(join(getAgentDir(), "settings.json")),
		...loadModeGateSettingsFile(join(cwd, ".pi", "settings.json")),
	};
}

function availableModes(exploreAvailable: boolean): Mode[] {
	return exploreAvailable ? ["watched", "explore", "yolo"] : ["watched", "yolo"];
}

export default function modeGateExtension(pi: ExtensionAPI): void {
	const settings = loadModeGateSettings();
	const modes = availableModes(settings.exploreAvailable);

	let currentMode: Mode = DEFAULT_MODE;

	const permissions = new Permissions();
	const pending = new Map<string, { path: string; input: string; generation: number }>();
	let generation = 0;
	function resetPermissions(): void {
		generation++;
		permissions.clear();
		pending.clear();
		requestRender?.();
	}

	const EXPLORE_BLOCKED = "BLOCKED: you are in explore mode — only read-only tools and safe commands are permitted. Do NOT retry. Do NOT use bash to write/edit files. Describe what you would change instead, concisely.";

	// The built-in footer renders extension statuses on their own line, so the mode is
	// drawn by a custom footer instead: it wraps the built-in one and right-aligns the
	// mode on its first line (cwd + branch), leaving the remaining lines untouched.
	let activeCtx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;

	function installFooter(ctx: ExtensionContext): void {
		activeCtx = ctx;
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			// FooterComponent reads only these four members off the agent session.
			const session = {
				get state() {
					return { model: activeCtx?.model, thinkingLevel: activeCtx?.thinkingLevel };
				},
				get sessionManager() {
					return activeCtx?.sessionManager;
				},
				getContextUsage: () => activeCtx?.getContextUsage(),
				get modelRuntime() {
					// ModelRegistry is a facade over ModelRuntime; the footer needs the runtime
					// itself for the subscription flag behind the cost figure.
					const runtime = (activeCtx?.modelRegistry as unknown as { runtime?: unknown } | undefined)?.runtime;
					return runtime ?? { isUsingSubscription: () => false };
				},
			};
			const inner = new FooterComponent(session as never, footerData);
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubscribe();
					inner.dispose();
				},
				invalidate() {
					inner.invalidate();
				},
				render(width: number): string[] {
					const lines = inner.render(width);
					const mode = theme.fg(MODE_COLORS[currentMode], `mode: ${MODE_LABELS[currentMode]}`);
					const modeWidth = visibleWidth(mode);
					let left = lines[0] ?? "";
					const available = Math.max(0, width - modeWidth - 1);
					if (visibleWidth(left) > available) {
						left = truncateToWidth(left, available, theme.fg("dim", "..."));
					}
					const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - modeWidth));
					// Guard the case where the mode alone is wider than the terminal.
					return [truncateToWidth(left + padding + mode, width), ...lines.slice(1)];
				},
			};
		});
	}

	function setMode(mode: Mode, ctx: ExtensionContext): void {
		if (currentMode === mode) return;
		currentMode = mode;
		resetPermissions();
		requestRender?.();
		ctx.ui.notify(`Mode: ${MODE_LABELS[mode]}`);
	}

	function cycleMode(ctx: ExtensionContext): void {
		const idx = modes.indexOf(currentMode);
		const next = modes[(idx + 1) % modes.length];
		setMode(next, ctx);
	}

	// /mode or /mode <name>
	pi.registerCommand("mode", {
		description: `Switch mode (${modes.join(" / ")}); reset approvals; allow <directory> for session content changes`,
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "reset") {
				resetPermissions();
				ctx.ui.notify("Mode Gate approvals cleared.");
				return;
			}
			if (arg.startsWith("allow ")) {
				if (currentMode !== "watched") { ctx.ui.notify("Switch to watched before granting content permission.", "warning"); return; }
				try {
					const path = toolPath(args.trim().slice(6).trim(), ctx.cwd);
					if (!statSync(path).isDirectory()) { ctx.ui.notify("Use an existing directory for /mode allow.", "warning"); return; }
					permissions.grant(path, true);
					ctx.ui.notify(`Content changes allowed under ${path} for this session. Execution and deletion still require review.`);
				} catch (error) { ctx.ui.notify(`Cannot grant scope: ${String(error)}`, "error"); }
				return;
			}

			if (arg && modes.includes(arg as Mode)) {
				setMode(arg as Mode, ctx);
				return;
			}

			const choice = await ctx.ui.select("Select mode:", modes.map((mode) => `${MODE_LABELS[mode]}  —  ${MODE_DESCRIPTIONS[mode]}`));

			if (!choice) return;

			if (choice.startsWith("watched")) setMode("watched", ctx);
			else if (choice.startsWith("yolo")) setMode("yolo", ctx);
			else if (choice.startsWith("explore")) setMode("explore", ctx);
		},
	});

	// Shift+Tab cycles modes
	pi.registerShortcut(Key.shift("tab"), {
		description: "Cycle permission mode",
		handler: async (ctx) => cycleMode(ctx),
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		pending.clear();
		const scopes = permissions.scopes.map((s) => `${s.directory ? "directory" : "file"}: ${s.path}`).join("\n");
		const categories = [...permissions.categories].map((key) => { const [cwd, category] = JSON.parse(key) as [string, string]; return `${category} in ${cwd}`; }).join("\n");
		return { message: {
			customType: "mode-gate", display: false,
			content: `Mode Gate: ${currentMode}. ${currentMode === "explore" ? "Read-only inspection; do not write files or retry blocked tools." : currentMode === "watched" ? "Changes under the content approvals below and programs under the execution approvals below run without prompting. Any other change, program, deletion, shared-system change or opaque command pauses and asks the user in a dialog, so attempt it normally instead of refusing. If the user denies it, do not retry it through another tool or a rewritten command." : "Permission prompts are disabled."}${scopes ? `\nContent approvals:\n${scopes}` : ""}${categories ? `\nExecution approvals:\n${categories}` : ""}`,
		} };
	});

	// Shared confirmation dialog with optional Tab-to-add-message
	async function confirmWithMessage(
		title: string,
		options: string[],
		ctx: ExtensionContext,
	): Promise<{ choice: string; message?: string } | undefined> {
		if (ctx.mode !== "tui") {
			const choice = await ctx.ui.select(title, options, { signal: ctx.signal });
			return choice ? { choice } : undefined;
		}
		return await ctx.ui.custom<{ choice: string; message?: string } | undefined>((tui, theme, _kb, done) => {
			let selectedIndex = Math.max(0, options.lastIndexOf("Block"));
			let inputMode = false;
			let cachedLines: string[] | undefined;
			let cachedWidth = -1;
			const onAbort = () => done(undefined);
			ctx.signal?.addEventListener("abort", onAbort, { once: true });
			if (ctx.signal?.aborted) onAbort();

			const input = new Input();

			input.onSubmit = (value) => {
				done({ choice: options[selectedIndex], message: value.trim() || undefined });
			};

			input.onEscape = () => {
				inputMode = false;
				input.setValue("");
				refresh();
			};

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function handleInput(data: string) {
				if (inputMode) {
					input.handleInput(data);
					refresh();
					return;
				}

				if (matchesKey(data, Key.up)) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					refresh();
				} else if (matchesKey(data, Key.down)) {
					selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
					refresh();
				} else if (matchesKey(data, Key.tab)) {
					inputMode = true;
					input.setValue("");
					refresh();
				} else if (matchesKey(data, Key.enter)) {
					done({ choice: options[selectedIndex], message: undefined });
				} else if (matchesKey(data, Key.escape)) {
					done(undefined);
				}
			}

			function render(width: number): string[] {
				if (cachedLines && cachedWidth === width) return cachedLines;
				cachedWidth = width;

				const lines: string[] = [];
				const add = (s: string) => lines.push(truncateToWidth(s, width));

				add(theme.fg("accent", "─".repeat(width)));
				const previewLines = title.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)));
				for (const line of previewLines.slice(0, 36)) add(theme.fg("text", ` ${line}`));
				if (previewLines.length > 36) add(theme.fg("muted", " [preview shortened; inspect full tool call]"));
				add(theme.fg("muted", " Tab: add note · Enter: confirm · Esc: block"));
				lines.push("");

				for (let i = 0; i < options.length; i++) {
					const selected = i === selectedIndex;
					const prefix = selected ? theme.fg("accent", " › ") : "   ";
					const label = selected ? theme.fg("accent", options[i]) : options[i];

					if (selected && inputMode) {
						add(prefix + label + theme.fg("muted", ", "));
						for (const line of input.render(Math.max(1, width - 4))) {
							add("    " + line);
						}
					} else {
						const wrapped = wrapTextWithAnsi(label, Math.max(1, width - 4));
						wrapped.forEach((line, index) => add((index ? "   " : prefix) + line));
					}
				}

				lines.push("");
				add(theme.fg("accent", "─".repeat(width)));
				cachedLines = lines;
				return lines;
			}

			return {
				get focused() { return input.focused; },
				set focused(value: boolean) { input.focused = value; },
				render,
				handleInput,
				invalidate: () => { cachedLines = undefined; },
				dispose: () => ctx.signal?.removeEventListener("abort", onAbort),
			};
		});
	}

	function preview(text: string, limit = 16): string {
		const lines = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "?").split("\n");
		return lines.slice(0, limit).map((line) => line.length > 800 ? `${line.slice(0, 800)} [line truncated]` : line).join("\n")
			+ (lines.length > limit ? `\n[${lines.length - limit} more lines; inspect the tool call for the complete request]` : "");
	}

	/** The differing middle of an edit with one line of leading context, so the preview shows the change itself. */
	function changedLines(oldText: string, newText: string): { removed: string[]; added: string[] } {
		const a = oldText.split("\n");
		const b = newText.split("\n");
		let start = 0;
		while (start < a.length && start < b.length && a[start] === b[start]) start++;
		let endA = a.length;
		let endB = b.length;
		while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
		const from = Math.max(0, start - 1);
		return { removed: a.slice(from, endA), added: b.slice(from, endB) };
	}

	async function confirm(analysis: Analysis, detail: string, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
		if (!ctx.hasUI) {
			return { block: true, reason: `BLOCKED: ${analysis.findings.map((f) => f.reason).join("; ")}. User confirmation requires a UI. Do not retry through another tool.` };
		}
		const choices = new Map<string, () => void>([["Allow once", () => {}]]);
		const relevant = analysis.findings.filter((f) => !f.routine);
		const writes = relevant.filter((f) => f.effect === "write");
		const executes = relevant.filter((f) => f.effect === "execute");
		// Scopes are offered only when every finding is nameable: a path for writes, a program for execution.
		const nameable = relevant.length > 0 && writes.length + executes.length === relevant.length && writes.every((f) => f.path) && executes.every((f) => f.category);
		if (nameable) {
			const categories = [...new Set(executes.map((f) => f.category!))];
			const grantCategories = () => categories.forEach((c) => permissions.categories.add(permissions.categoryKey(analysis.cwd, c)));
			const andCommands = categories.length ? ` and ${categories.join(", ")} commands` : "";
			if (writes.length) {
				choices.set(`Allow these file changes${andCommands} this session`, () => { writes.forEach((f) => permissions.grant(f.path!, false)); grantCategories(); });
				const parents = [...new Set(writes.map((f) => dirname(f.path!)))];
				if (parents.length === 1) {
					// A file in a directory that does not exist yet is scoped to its nearest existing ancestor.
					let scope = parents[0];
					while (!exists(scope) && inside(scope, analysis.cwd) && scope !== analysis.cwd) scope = dirname(scope);
					if (inside(scope, analysis.cwd) && exists(scope)) {
						choices.set(`Allow content changes under ${preview(scope, 1)}${andCommands} this session`, () => { permissions.grant(scope, true); grantCategories(); });
					}
				}
			} else {
				choices.set(`Allow ${categories.join(", ")} commands in this cwd this session`, grantCategories);
			}
		}
		choices.set("Block", () => {});
		const version = generation;
		const reasons = analysis.findings.map((f) => `${f.effect}: ${f.reason}${f.path ? `\n  ${f.path}` : ""}`).join("\n");
		const result = await confirmWithMessage(`${preview(reasons, 8)}\nCwd: ${preview(analysis.cwd, 1)}\n\n${preview(detail)}`, [...choices.keys()], ctx);
		if (version !== generation || ctx.signal?.aborted) return { block: true, reason: "BLOCKED: permission context changed or request was cancelled." };
		if (!result || result.choice === "Block" || !choices.has(result.choice)) {
			return { block: true, reason: `BLOCKED: user ${result ? "denied" : "cancelled"} this action.${result?.message ? ` Note: ${result.message}.` : ""} Do not retry through another tool.` };
		}
		choices.get(result.choice)!();
		if (result.message) pi.sendMessage({
			customType: "mode-gate-note", display: true,
			content: `Approval note for the pending tool call, which will execute once after this approval. Apply the note to the ongoing task; do not repeat the call merely to acknowledge the note.\nUser note: ${result.message}`,
		});
		return undefined;
	}

	// Gate tool calls
	pi.on("tool_call", async (event, ctx) => {
		// Yolo: everything passes
		if (currentMode === "yolo") return undefined;

		if (["read", "read_image", "grep", "find", "ls", "web_search", "fetch_content"].includes(event.toolName)) return undefined;
		if (!["edit", "write", "bash"].includes(event.toolName)) {
			if (currentMode === "explore") return { block: true, reason: `${EXPLORE_BLOCKED} Tool ${event.toolName} has unclassified effects.` };
			return confirm({ cwd: ctx.cwd, findings: [{ effect: "unknown", reason: `Tool ${event.toolName} has unclassified effects` }] }, `${event.toolName}\n${JSON.stringify(event.input, null, 2)}`, ctx);
		}
		try {
			const input = event.input as Record<string, unknown>;
			let analysis: Analysis;
			let detail: string;
			let created: string | undefined;
			const inputSnapshot = JSON.stringify(event.input);
			if (event.toolName === "bash") {
				const command = event.input.command as string;
				analysis = analyzeCommand(command, ctx.cwd);
				detail = `$ ${command}`;
			} else {
				const path = toolPath(input.path as string || input.file_path as string, ctx.cwd);
				analysis = analyzeFile(path, canonicalPath(ctx.cwd));
				if (permissions.isCreated(path)) created = path;
				if (event.toolName === "write") {
					detail = `${exists(path) ? "Overwrite" : "Create"}: ${path}\n${String(event.input.content)}`;
					if (!exists(path)) created = path;
				} else {
					const edits = input.edits as { oldText: string; newText: string }[] | undefined;
					const changes = edits ?? [{ oldText: input.oldText as string, newText: input.newText as string }];
					detail = `Edit: ${path}\n` + changes.map((e) => {
						const { removed, added } = changedLines(e.oldText ?? "", e.newText ?? "");
						return `- ${preview(removed.join("\n"), 6).replace(/\n/g, "\n- ")}\n+ ${preview(added.join("\n"), 6).replace(/\n/g, "\n+ ")}`;
					}).join("\n");
				}
			}
			if (currentMode === "explore") {
				return analysis.findings.length ? { block: true, reason: `${EXPLORE_BLOCKED}\n${analysis.findings.map((f) => f.reason).join("; ")}` } : undefined;
			}
			if (permissions.needsApproval(analysis)) {
				const blocked = await confirm(analysis, detail, ctx);
				if (blocked) return blocked;
			}
			if (created) pending.set(event.toolCallId, { path: created, input: inputSnapshot, generation });
			return undefined;
		} catch (error) {
			return { block: true, reason: `BLOCKED: Mode Gate could not analyze the request: ${String(error)}. Do not retry through another tool.` };
		}
	});
	pi.on("tool_result", async (event) => {
		const creation = pending.get(event.toolCallId);
		if (creation && !event.isError && creation.generation === generation && creation.input === JSON.stringify(event.input)) {
			permissions.rememberCreated(creation.path);
		}
		pending.delete(event.toolCallId);
	});
	pi.on("tool_execution_end", async (event) => { pending.delete(event.toolCallId); });
	pi.on("session_tree", async () => resetPermissions());
	pi.on("session_shutdown", async () => resetPermissions());

	// Always start in watched mode
	pi.on("session_start", async (_event, ctx) => {
		currentMode = DEFAULT_MODE;
		resetPermissions();
		installFooter(ctx);
	});
}
