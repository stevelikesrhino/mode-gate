import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const USAGE_SETTINGS_URL = "https://chatgpt.com/settings/usage";
const FIVE_HOURS = 5 * 60 * 60;
const ONE_WEEK = 7 * 24 * 60 * 60;

export interface UsageWindow {
	label: string;
	usedPercent?: number;
	resetAt?: number;
}

export interface UsageSnapshot {
	plan: string;
	windows: UsageWindow[];
	fetchedAt: number;
	blocked: boolean;
}

// Only these deliberately written errors may be displayed; never render auth
// errors, response bodies, or tokens returned by a provider.
export class UsageError extends Error {
	constructor(message: string, readonly hint: string = USAGE_SETTINGS_URL) {
		super(message);
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseUsage(payload: unknown, now = Date.now()): UsageSnapshot {
	const data = record(payload);
	const limits = record(data?.rate_limit);
	const plan = typeof data?.plan_type === "string" && /^[a-z0-9_-]{1,32}$/i.test(data.plan_type)
		? data.plan_type.toLowerCase() : "unknown plan";
	if (plan === "free") {
		throw new UsageError("No active openai subscriptino", "The Codex login reports a free ChatGPT plan.");
	}
	if (!limits) throw new UsageError("OpenAI did not return subscription usage windows.");
	const rawWindows = [record(limits.primary_window), record(limits.secondary_window)];
	// Window positions change across plans. Identify their durations, not their slots.
	const fiveHour = rawWindows.find(window => window?.limit_window_seconds === FIVE_HOURS);
	const weekly = rawWindows.find(window => window?.limit_window_seconds === ONE_WEEK);
	const windows: UsageWindow[] = [];

	function addWindow(label: string, raw: Record<string, unknown> | undefined): void {
		const used = finiteNumber(raw?.used_percent);
		const resetAt = finiteNumber(raw?.reset_at);
		const resetAfter = finiteNumber(raw?.reset_after_seconds);
		const resetMs = resetAt !== undefined && resetAt > 0 ? resetAt * 1000
			: resetAfter !== undefined && resetAfter >= 0 ? now + resetAfter * 1000 : undefined;
		windows.push({
			label,
			usedPercent: used === undefined ? undefined : Math.max(0, Math.min(100, used)),
			resetAt: resetMs !== undefined && Number.isFinite(new Date(resetMs).getTime()) ? resetMs : undefined,
		});
	}

	const isPlus = plan === "plus";
	const isPro = plan === "pro" || plan.startsWith("pro_");
	if (isPlus || (!isPro && fiveHour)) addWindow("5 hours", fiveHour);
	if (isPlus || isPro || weekly) addWindow("Weekly", weekly);
	return { plan, windows, fetchedAt: now, blocked: limits.allowed === false || limits.limit_reached === true };
}

export async function fetchUsage(ctx: ExtensionContext, signal: AbortSignal): Promise<UsageSnapshot> {
	// OpenAI token-sharing credentials cannot read wham/usage. Do not send those
	// credentials to that endpoint or silently assume a different account's limits.
	const models = ctx.modelRegistry.getAll();
	const model = models.find(model => model.provider === "openai-codex");
	if (!model || !ctx.modelRegistry.isUsingOAuth(model)) {
		const openai = models.find(model => model.provider === "openai");
		if (!openai || !ctx.modelRegistry.isUsingOAuth(openai)) {
			throw new UsageError("No active openai subscriptino", "Sign in with /login openai-codex to view usage.");
		}
		throw new UsageError(
			"Live usage needs /login openai-codex with the same ChatGPT account.",
			`The newer openai login cannot read limits. ${USAGE_SETTINGS_URL}`,
		);
	}

	let token: string | undefined;
	try {
		token = (await ctx.modelRegistry.getProviderAuth("openai-codex"))?.auth.apiKey;
	} catch {
		throw new UsageError("Cannot refresh the Codex login. Run /login openai-codex.");
	}
	signal.throwIfAborted();
	if (!token) throw new UsageError("No Codex access token. Run /login openai-codex.");

	let accountId: unknown;
	try {
		const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		// Only the sanitized diagnostic below is shown.
	}
	if (typeof accountId !== "string" || !accountId || /[\r\n]/.test(accountId)) {
		throw new UsageError("Codex login has no account ID. Run /login openai-codex.");
	}

	const response = await fetch(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${token}`,
			"ChatGPT-Account-Id": accountId,
			Accept: "application/json",
		},
		signal,
		redirect: "error",
		cache: "no-store",
	});
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 401 || response.status === 403) {
			throw new UsageError("OpenAI rejected the Codex login. Run /login openai-codex.");
		}
		if (response.status === 429) throw new UsageError("Usage refresh rate-limited. Wait before pressing r again.");
		throw new UsageError(`Usage request failed (HTTP ${response.status}). Press r to retry.`);
	}
	return parseUsage(await response.json());
}
