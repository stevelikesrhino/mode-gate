import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installFastFooter } from "./footer.ts";
import { registerUsage } from "./usage.ts";

export function supportsFast(model: ExtensionContext["model"]): boolean {
	return model !== undefined &&
		(model.provider === "openai" || model.provider === "openai-codex") &&
		(model.api === "openai-responses" || model.api === "openai-codex-responses" || model.api === "openai-completions");
}

export default function piOpenAI(pi: ExtensionAPI): void {
	registerUsage(pi);

	// Runtime-only opt-in. Never restore priority billing from session history.
	let enabled = false;
	let footerInstalled = false;
	let requestRender: (() => void) | undefined;

	function fastActive(ctx: ExtensionContext): boolean {
		return enabled && supportsFast(ctx.model);
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
				const next = action === "" ? !enabled : action === "on";
				if (next && !supportsFast(ctx.model)) {
					ctx.ui.notify("Fast mode requires an openai or openai-codex model using an OpenAI API.", "warning");
					return;
				}
				enabled = next;
				updateFooter(ctx);
			}
			const detail = enabled
				? supportsFast(ctx.model)
					? "priority service requested for subsequent calls; higher costs/usage may apply"
					: "inactive for the current provider"
				: "normal service";
			ctx.ui.notify(`Fast mode ${enabled ? "on" : "off"}: ${detail}.`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fastActive(ctx)) return;
		if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return;
		return { ...event.payload, service_tier: "priority" };
	});

	pi.on("session_start", (_event, ctx) => {
		// Startup, resume, reload, new sessions, and forks all require a fresh opt-in.
		enabled = false;
		if (footerInstalled && ctx.mode === "tui") ctx.ui.setFooter(undefined);
		footerInstalled = false;
		requestRender = undefined;
	});
	pi.on("model_select", (_event, ctx) => updateFooter(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		enabled = false;
		if (footerInstalled && ctx.mode === "tui") ctx.ui.setFooter(undefined);
		footerInstalled = false;
		requestRender = undefined;
	});
}
