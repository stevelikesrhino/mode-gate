import type { FastMode } from "./request-policy.ts";
import { supportsFast } from "./request-policy.ts";

type RequestModel = { provider: string; api: string };
type PayloadHook = (payload: unknown, model?: RequestModel) => unknown | Promise<unknown>;
type RequestOptions = Record<string, unknown> & { onPayload?: PayloadHook };
type PreparedRequest = {
	model: RequestModel;
	options: RequestOptions;
	[key: string]: unknown;
};
type PrepareRequest = (model: RequestModel, options?: RequestOptions) => Promise<PreparedRequest>;

const OWNER = Symbol.for("ccc-evo.fast-runtime-policy");
type Runtime = { prepareRequest: PrepareRequest; [OWNER]?: { disable(): void; conflicted?: boolean } };

export interface RuntimePolicy {
	isActive(): boolean;
	dispose(): void;
}

/**
 * Wrap Pi 1.3's private request-preparation boundary for this runtime only.
 * Native summaries skip agent payload hooks but still pass through here.
 */
export function installRuntimePolicy(registry: unknown, mode: FastMode): RuntimePolicy {
	const runtime = (registry as { runtime?: Runtime } | undefined)?.runtime;
	if (!runtime || typeof runtime.prepareRequest !== "function") {
		throw new Error("This Pi version does not expose ModelRuntime.prepareRequest; /fast cannot cover native inference.");
	}
	// Native summaries lack a reliable owning-session ID. Multiple controllers
	// could apply one session's priority billing to another, so never stack them.
	if (runtime[OWNER]) {
		// Keep the conflict marker for this runtime's lifetime. A rejected session
		// may still be using it after the original owner reloads or shuts down.
		runtime[OWNER].conflicted = true;
		runtime[OWNER].disable();
		throw new Error("Multiple ccc-evo sessions share this ModelRuntime; /fast is disabled. Use separate runtimes.");
	}
	const descriptor = Object.getOwnPropertyDescriptor(runtime, "prepareRequest");
	const original = runtime.prepareRequest;
	let active = true;
	const owner = { conflicted: false, disable() { active = false; mode.enabled = false; } };
	const wrapped: PrepareRequest = async function (this: Runtime, model, options) {
		const prepared = await original.call(this, model, options);
		if (!active || !supportsFast(prepared.model)) return prepared;
		const previous = prepared.options.onPayload;
		return {
			...prepared,
			options: {
				...prepared.options,
				onPayload: async (payload, requestModel) => {
					// Run the caller once, preserving replacement or mutation. Read Fast
					// after it resolves so a toggle during an async hook takes effect.
					const replacement = await previous?.call(prepared.options, payload, requestModel);
					const current = replacement === undefined ? payload : replacement;
					if (!active || typeof current !== "object" || current === null || Array.isArray(current)) return current;
					return mode.prepareRequest(current as Record<string, unknown>, requestModel ?? prepared.model);
				},
			},
		};
	};

	runtime.prepareRequest = wrapped;
	try {
		runtime[OWNER] = owner;
	} catch (error) {
		if (descriptor) Object.defineProperty(runtime, "prepareRequest", descriptor);
		else Reflect.deleteProperty(runtime, "prepareRequest");
		throw error;
	}
	return {
		isActive: () => active,
		dispose() {
			// Retained callbacks must stop changing billing after shutdown. Restore
			// the method only if a later wrapper has not replaced it.
			owner.disable();
			if (runtime.prepareRequest === wrapped) {
				if (descriptor) Object.defineProperty(runtime, "prepareRequest", descriptor);
				else Reflect.deleteProperty(runtime, "prepareRequest");
			}
			if (runtime[OWNER] === owner && !owner.conflicted) Reflect.deleteProperty(runtime, OWNER);
		},
	};
}
