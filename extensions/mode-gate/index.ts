/**
 * Mode Gate Extension
 *
 * Three-mode permission system:
 * - watched: prompts before edit/write/destructive bash
 * - yolo: no prompts, full access
 * - explore: read-only, no edit/write, bash allowlisted
 *
 * Shift+Tab cycles modes. /mode to pick or /mode <name> to switch directly.
 * Always starts in explore mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { isDestructiveCommand, isSafeCommand } from "./utils.js";

type Mode = "watched" | "yolo" | "explore";

const MODES: Mode[] = ["explore", "watched", "yolo"];

const ALL_TOOLS = ["read", "read_image", "bash", "edit", "write", "grep", "find", "ls", "mode-guideline"];

const MODE_LABELS: Record<Mode, string> = {
	watched: "watched",
	yolo: "yolo",
	explore: "explore",
};

export default function modeGateExtension(pi: ExtensionAPI): void {
	let currentMode: Mode = "explore";
	let lastActiveMode: Mode | undefined = undefined;

	// Per-tool-type "allow all this response" flags, reset on mode change and each turn
	const allowAll: Record<string, boolean> = {};

	function resetAllowAll(): void {
		for (const key in allowAll) delete allowAll[key];
	}

	const EXPLORE_BLOCKED = "BLOCKED: you are in explore mode — only read-only tools and safe commands are permitted. Do NOT retry. Do NOT use bash to write/edit files. Describe what you would change instead, concisely.";
	const EXPLORE_TEXT = "Runtime mode is now explore. Do not edit/write files; read-only tools and safe commands only.";
	const WATCHED_TEXT = "Runtime mode is now watched. Edits/writes/destructive bash require user approval.";
	const YOLO_TEXT = "Runtime mode is now yolo. Tool calls are not approval-gated by mode-gate.";

	function updateStatus(ctx: ExtensionContext): void {
		if (currentMode === "watched") {
			ctx.ui.setStatus("mode-gate", ctx.ui.theme.fg("accent", `mode: ${MODE_LABELS[currentMode]}`));
		} else if (currentMode === "yolo") {
			ctx.ui.setStatus("mode-gate", ctx.ui.theme.fg("warning", `mode: ${MODE_LABELS[currentMode]}`));
		} else {
			ctx.ui.setStatus("mode-gate", ctx.ui.theme.fg("success", `mode: ${MODE_LABELS[currentMode]}`));
		}
	}

	function setMode(mode: Mode, ctx: ExtensionContext): void {
		if (currentMode === mode) return;
		currentMode = mode;
		resetAllowAll();
		pi.setActiveTools(ALL_TOOLS);
		updateStatus(ctx);
		ctx.ui.notify(`Mode: ${MODE_LABELS[mode]}`);
	}

	function cycleMode(ctx: ExtensionContext): void {
		const idx = MODES.indexOf(currentMode);
		const next = MODES[(idx + 1) % MODES.length];
		setMode(next, ctx);
	}

	// /mode or /mode <name>
	pi.registerCommand("mode", {
		description: "Switch permission mode (watched / yolo / explore)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg && MODES.includes(arg as Mode)) {
				setMode(arg as Mode, ctx);
				return;
			}

			const choice = await ctx.ui.select("Select mode:", [
				"watched  —  confirm edits & destructive bash",
				"yolo  —  no prompts, full access",
				"explore  —  read-only, safe bash only",
			]);

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

	// Reset "allow_all" every turn
	pi.on("before_agent_start", async (event, _ctx) => {
		resetAllowAll();
		if (currentMode === lastActiveMode) return;
		lastActiveMode = currentMode;

		const content = currentMode === "explore" ? EXPLORE_TEXT :
			currentMode === "watched" ? WATCHED_TEXT : YOLO_TEXT;

		return {
			message: {
				customType: "system-reminder",
				content,
				display: false,
			},
		};
	});

	// Shared confirmation dialog with optional Tab-to-add-message
	async function confirmWithMessage(
		title: string,
		options: string[],
		ctx: ExtensionContext,
	): Promise<{ choice: string; message?: string } | undefined> {
		return await ctx.ui.custom<{ choice: string; message?: string } | undefined>((tui, theme, _kb, done) => {
			let selectedIndex = 0;
			let inputMode = false;
			let cachedLines: string[] | undefined;

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
				} else if (matchesKey(data, Key.tab) && (selectedIndex === 0 || selectedIndex === options.length - 1)) {
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
				if (cachedLines) return cachedLines;

				const lines: string[] = [];
				const add = (s: string) => lines.push(truncateToWidth(s, width));

				add(theme.fg("accent", "─".repeat(width)));
				add(theme.fg("text", ` ${title}`));
				add(theme.fg("muted", " Tab to add a message on Allow/Block · Enter confirm · Esc cancel"));
				lines.push("");

				for (let i = 0; i < options.length; i++) {
					const selected = i === selectedIndex;
					const prefix = selected ? theme.fg("accent", " › ") : "   ";
					const label = selected ? theme.fg("accent", options[i]) : options[i];

					if (selected && inputMode) {
						add(prefix + label + theme.fg("muted", ", "));
						for (const line of input.render(width - 4)) {
							add("    " + line);
						}
					} else {
						add(prefix + label);
					}
				}

				lines.push("");
				add(theme.fg("accent", "─".repeat(width)));
				cachedLines = lines;
				return lines;
			}

			return {
				render,
				handleInput,
				invalidate: () => { cachedLines = undefined; },
			};
		});
	}

	// Shared watched-mode confirmation handler
	async function handleWatchedConfirm(
		toolLabel: string,
		displayTitle: string,
		setAllowAll: () => void,
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined> {
		if (!ctx.hasUI) {
			return { block: true, reason: `BLOCKED: ${toolLabel} requires user confirmation but no UI is available. Do NOT retry. STOP right now.` };
		}

		const allowAllLabel = `Allow all ${toolLabel} this response`;
		const result = await confirmWithMessage(displayTitle, ["Allow", allowAllLabel, "Block"], ctx);

		if (!result) return { block: true, reason: "BLOCKED: user cancelled. Do NOT retry, your action is blocked. Ask the user how to proceed." };

		if (result.choice === allowAllLabel) setAllowAll();
		if (result.choice === "Allow" && result.message) {
			pi.sendMessage({ customType: "follow-up", content: result.message, display: true });
		}
		if (result.choice === "Block") {
			const note = result.message ? ` with note: ${result.message}` : "";
			return { block: true, reason: `BLOCKED: user denied this ${toolLabel}${note}. Do NOT retry, your action is blocked. Ask the user how to proceed.` };
		}
		return undefined;
	}

	// Gate tool calls
	pi.on("tool_call", async (event, ctx) => {
		// Yolo: everything passes
		if (currentMode === "yolo") return undefined;

		// Explore: block edit/write and unsafe bash
		if (currentMode === "explore") {
			if (event.toolName === "edit" || event.toolName === "write") {
				return { block: true, reason: EXPLORE_BLOCKED };
			}
			if (event.toolName === "bash") {
				const command = event.input.command as string;
				if (!isSafeCommand(command)) {
					return { block: true, reason: EXPLORE_BLOCKED };
				}
			}
			return undefined;
		}

		// watched mode: confirm edit, write, destructive bash
		if (event.toolName === "edit") {
			if (allowAll["edit"]) return undefined;
			const path = event.input.file_path as string || event.input.path as string || "unknown";
			return handleWatchedConfirm("edit", `Edit: ${path}`, () => { allowAll["edit"] = true }, ctx);
		}

		if (event.toolName === "write") {
			if (allowAll["write"]) return undefined;
			const path = event.input.file_path as string || event.input.path as string || "unknown";
			return handleWatchedConfirm("write", `Write: ${path}`, () => { allowAll["write"] = true }, ctx);
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isDestructiveCommand(command)) return undefined;
			if (allowAll["bash"]) return undefined;
			return handleWatchedConfirm("bash", `Bash: ${command}`, () => { allowAll["bash"] = true }, ctx);
		}

		return undefined;
	});

	// Always start in explore mode
	pi.on("session_start", async (_event, ctx) => {
		currentMode = "explore";
		lastActiveMode = "explore";
		resetAllowAll();
		pi.setActiveTools(ALL_TOOLS);
		updateStatus(ctx);
		// Register internal tool with mode descriptions in system prompt
		pi.registerTool({
			name: "mode-guideline",
			label: "Mode Gate",
			description: "This tool is NOT callable.\n"+
			"- Mode: explore — you cannot write or edit or make file changes.\n"+
			"- Mode: watched — edits, writes, and destructive bash commands require user approval.\n"+
			"- Mode: yolo — full access with no prompts.\n"+
			"- Default explore mode.\n",
			parameters: Type.Object({}),
			async execute() {
				throw new Error("mode_gate_internal should never be called");
			},
		});
	});
}
