/**
 * Extends Pi's bash with a required description; execution stays native.
 * Each call defaults to one status-colored `bash  description` line.
 * Click cycles short / native preview / expanded; Ctrl+O toggles all calls.
 */
import { stripVTControlCharacters } from "node:util";
import {
	createBashToolDefinition,
	type BashToolDetails,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, MouseRegion, Spacer, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

type NativeBash = ReturnType<typeof createBashToolDefinition>;
type NativeContext = Parameters<NonNullable<NativeBash["renderCall"]>>[2];
type ViewMode = "short" | "preview" | "expanded";
type RowState = {
	nativeState?: NativeContext["state"];
	nativeCall?: Component;
	nativeResult?: Component;
};
type RenderContext = Omit<NativeContext, "state"> & { state: RowState };

const empty: Component = { render: () => [], invalidate() {} };

function describe(args: unknown): string {
	const input = args as { description?: unknown; command?: unknown } | undefined;
	const value = typeof input?.description === "string" && input.description.trim()
		? input.description
		: typeof input?.command === "string" ? input.command.split("\n")[0] : "Preparing command";
	return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()
		|| "Preparing command";
}

function nativeContext(context: RenderContext, mode: ViewMode, slot: "call" | "result"): NativeContext {
	const state = context.state;
	return {
		...context,
		// Match Pi's empty initial renderer state, without exposing our wrapper fields.
		state: state.nativeState ??= {} as NativeContext["state"],
		expanded: mode === "expanded",
		lastComponent: slot === "call" ? state.nativeCall : state.nativeResult,
	};
}

/** Each slot owns its framing; result rendering never mutates the call component. */
function frameSlot(component: Component, context: RenderContext, theme: Theme, slot: "call" | "result"): Component {
	const background = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(context.outputPad, 0, (text) => theme.bg(background, text));
	if (slot === "call") box.addChild(new Spacer(1));
	box.addChild(component);
	if (slot === "result") box.addChild(new Spacer(1));
	return box;
}

/** Current Pi uses a Node timer here; it has no public renderer-disposal hook. */
function clearNativeTimer(state: NativeContext["state"] | undefined): void {
	if (!state) return;
	const timerState = state as { interval?: unknown };
	const timer = timerState.interval;
	if (typeof timer !== "object" || timer === null ||
		!("hasRef" in timer) || typeof timer.hasRef !== "function" ||
		!("refresh" in timer) || typeof timer.refresh !== "function") return;
	clearInterval(timer as ReturnType<typeof setInterval>);
	timerState.interval = undefined;
}

export default function shorterBash(pi: ExtensionAPI): void {
	const rows = new Set<RowState>();
	const views = new Map<string, ViewMode>();

	function clearRenderState(): void {
		for (const state of rows) clearNativeTimer(state.nativeState);
		rows.clear();
		views.clear();
	}

	function registerBash(ctx: ExtensionContext): void {
		let toolsExpanded = ctx.ui.getToolsExpanded();
		function viewMode(context: RenderContext): ViewMode {
			if (ctx.mode !== "tui") return context.expanded ? "expanded" : "short";
			// Ctrl+O resets click overrides. Read Pi's global flag, since new rows are
			// constructed collapsed before Pi applies that flag to each component.
			const expanded = ctx.ui.getToolsExpanded();
			if (expanded !== toolsExpanded) {
				views.clear();
				toolsExpanded = expanded;
			}
			return views.get(context.toolCallId) ?? (expanded ? "expanded" : "short");
		}
		function clickable(component: Component, context: RenderContext): Component {
			return new MouseRegion(component, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				const mode = viewMode(context);
				views.set(context.toolCallId, mode === "short" ? "preview"
					: mode === "preview" ? "expanded" : "short");
				context.invalidate();
				return { handled: true };
			});
		}

		const settings = pi.getSettings();
		const base = createBashToolDefinition(ctx.cwd, {
			shellPath: settings.shellPath,
			commandPrefix: settings.shellCommandPrefix,
		});
		const parameters = Type.Object({
			...base.parameters.properties,
			description: Type.String({
				description: "Short, plain-language description of what this command does. Use one brief line, not the shell command.",
				minLength: 1,
			}),
		});

		pi.registerTool<typeof parameters, BashToolDetails | undefined, RowState>({
			...base,
			parameters,
			prepareArguments: base.prepareArguments ? (args) => ({
				...base.prepareArguments!(args),
				description: (args as Static<typeof parameters>)?.description,
			}) : undefined,
			renderShell: "self",
			renderCall(args, theme, context) {
				const state = context.state;
				rows.add(state);
				const mode = viewMode(context);
				state.nativeCall = base.renderCall!(args, theme, nativeContext(context, mode, "call"));
				if (mode !== "short") {
					const component = base.renderShell === "self" ? state.nativeCall
						: frameSlot(state.nativeCall, context, theme, "call");
					return clickable(component, context);
				}

				return clickable({
					invalidate() {},
					render(width) {
						const running = context.executionStarted && context.isPartial && !context.isError;
						const color = context.isError ? "error" : !context.isPartial ? "success"
							: running ? "accent" : "muted";
						const status = running ? theme.fg("muted", "  (running)") : "";
						const line = `${theme.fg(color, "bash")}  ${theme.fg("toolOutput", describe(args))}${status}`;
						const padding = " ".repeat(Math.min(context.outputPad, Math.max(0, width - 1)));
						return [truncateToWidth(padding + line, width)];
					},
				}, context);
			},
			renderResult(result, options, theme, context) {
				const state = context.state;
				const mode = viewMode(context);
				rows.add(state);
				state.nativeResult = base.renderResult!(result, { ...options, expanded: mode === "expanded" },
					theme, nativeContext(context, mode, "result"));
				if (mode === "short") return empty;
				const component = base.renderShell === "self" ? state.nativeResult
					: frameSlot(state.nativeResult, context, theme, "result");
				return clickable(component, context);
			},
		});
	}

	pi.on("session_start", (_event, ctx) => {
		clearRenderState();
		registerBash(ctx);
	});
	pi.on("session_tree", clearRenderState);
	pi.on("session_compact", clearRenderState);
	pi.on("session_shutdown", clearRenderState);
}
