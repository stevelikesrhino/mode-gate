import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { installFastFooter } from "./openai/footer.ts";
import { registerUsage } from "./openai/usage.ts";
import { createFastMode, supportsFast, type FastMode } from "./request-policy.ts";
import { installRuntimePolicy, type RuntimePolicy } from "./runtime-policy.ts";

export default function registerFastMode(pi: ExtensionAPI, mode: FastMode = createFastMode()): void {
	registerUsage(pi);

	// Runtime-only opt-in. Never restore priority billing from session history.
	let footerInstalled = false;
	let requestRender: (() => void) | undefined;
	let runtimePolicy: RuntimePolicy | undefined;
	let runtimeError: string | undefined;
	let unregisterCleanup: (() => void) | undefined;

	function detachRuntime(): void {
		mode.enabled = false;
		runtimePolicy?.dispose();
		runtimePolicy = undefined;
		unregisterCleanup?.();
		unregisterCleanup = undefined;
	}

	function attachRuntime(ctx: ExtensionContext): void {
		try {
			runtimePolicy = installRuntimePolicy(ctx.modelRegistry, mode);
			const sessionId = ctx.sessionManager.getSessionId();
			// SDK dispose() does not emit session_shutdown, but does run this cleanup.
			unregisterCleanup = registerSessionResourceCleanup((disposedId) => {
				if (disposedId === undefined || disposedId === sessionId) detachRuntime();
			});
		} catch (error) {
			detachRuntime();
			runtimeError = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(runtimeError, "error");
		}
	}

	function fastActive(ctx: ExtensionContext): boolean {
		return mode.enabled && supportsFast(ctx.model);
	}

	function updateFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (fastActive(ctx)) {
			if (!footerInstalled) {
				requestRender = installFastFooter(
					ctx,
					() => pi.getSettings().compaction?.enabled ?? true,
					() => fastActive(ctx),
				);
				footerInstalled = true;
			}
			requestRender?.();
		} else if (footerInstalled) {
			ctx.ui.setFooter(undefined);
			footerInstalled = false;
			requestRender = undefined;
		}
	}

	pi.registerCommand("fast", {
		description: "Toggle OpenAI priority service: /fast [on|off|status] (higher costs/usage may apply)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!["", "on", "off", "status"].includes(action)) {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}
			if (action !== "status") {
				const next = action === "" ? !mode.enabled : action === "on";
				if (next && !supportsFast(ctx.model)) {
					ctx.ui.notify("Fast mode requires an openai or openai-codex model using an OpenAI API.", "warning");
					return;
				}
				if (next) {
					if (!runtimePolicy && !runtimeError) attachRuntime(ctx);
					if (!runtimePolicy?.isActive()) {
						ctx.ui.notify(runtimeError ?? "The /fast runtime policy is inactive; reload with a separate ModelRuntime.", "error");
						return;
					}
				}
				mode.enabled = next;
				updateFooter(ctx);
			}
			const detail = mode.enabled
				? supportsFast(ctx.model)
					? "priority service requested for subsequent calls; higher costs/usage may apply"
					: "inactive for the current provider"
				: "normal service";
			ctx.ui.notify(`Fast mode ${mode.enabled ? "on" : "off"}: ${detail}.`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// Register even while OFF: a second session sharing this runtime must be
		// detected before it can inherit another session's billing policy.
		detachRuntime();
		runtimeError = undefined;
		attachRuntime(ctx);
		if (footerInstalled && ctx.mode === "tui") ctx.ui.setFooter(undefined);
		footerInstalled = false;
		requestRender = undefined;
	});
	pi.on("model_select", (_event, ctx) => updateFooter(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		detachRuntime();
		if (footerInstalled && ctx.mode === "tui") ctx.ui.setFooter(undefined);
		footerInstalled = false;
		requestRender = undefined;
	});
}
