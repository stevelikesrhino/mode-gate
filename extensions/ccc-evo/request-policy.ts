type RequestModel = { provider: string; api: string };

export type RequestPolicy = (payload: Record<string, unknown>, model: RequestModel | undefined) => Record<string, unknown>;

export interface FastMode {
	enabled: boolean;
	prepareRequest: RequestPolicy;
}

export function supportsFast(model: RequestModel | undefined): boolean {
	return model !== undefined &&
		(model.provider === "openai" || model.provider === "openai-codex") &&
		(model.api === "openai-responses" || model.api === "openai-codex-responses" || model.api === "openai-completions");
}

/** Live opt-in shared by Pi's runtime and direct compaction transports. */
export function createFastMode(): FastMode {
	const mode: FastMode = {
		enabled: false,
		prepareRequest(payload, model) {
			// OFF preserves the caller's tier; the override must not mutate captures.
			if (!mode.enabled || !supportsFast(model)) return payload;
			return { ...payload, service_tier: "priority" };
		},
	};
	return mode;
}
