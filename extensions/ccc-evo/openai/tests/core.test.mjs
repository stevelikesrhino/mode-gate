// Offline contracts only. Run: node --test extensions/ccc-evo/openai/tests/core.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = process.env.PI_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(path.join(root, "node_modules/jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, {
	fsCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(root, "dist/index.js"),
		"@earendil-works/pi-ai": path.join(root, "node_modules/@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-tui": path.join(root, "node_modules/@earendil-works/pi-tui/dist/index.js"),
	},
});
const load = name => jiti.import(fileURLToPath(new URL(`../${name}.ts`, import.meta.url)));
const { default: register } = await jiti.import(fileURLToPath(new URL("../../fast.ts", import.meta.url)));
const { fetchUsage, parseUsage, UsageError } = await load("usage-api");
const { registerUsage } = await load("usage");
const flush = () => new Promise(resolve => setImmediate(resolve));
const jwt = accountId => `fake.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: accountId },
})).toString("base64url")}.fake`;
const payload = (used = 20) => ({
	plan_type: "plus",
	rate_limit: {
		primary_window: { limit_window_seconds: 18000, used_percent: used },
		secondary_window: { limit_window_seconds: 604800, used_percent: 30 },
	},
});

function fixture(t) {
	const handlers = new Map(), commands = new Map();
	const f = {
		branch: [], requests: [], token: jwt("test-account"), oauth: true,
		runtime: { async prepareRequest(model, options = {}) { return { model, options }; } },
		models: [{ id: "fixture", provider: "openai-codex", api: "openai-codex-responses" }],
		respond: () => Response.json(payload()),
	};
	// No path from this fixture to real fetch or stored credentials.
	t.mock.method(globalThis, "fetch", async (url, options) => {
		f.requests.push({ url, ...options });
		return f.respond(options);
	});
	f.ctx = {
		mode: "print", model: f.models[0],
		sessionManager: { getBranch: () => f.branch, getSessionId: () => t.name },
		modelRegistry: {
			runtime: f.runtime,
			getAll: () => f.models,
			isUsingOAuth: () => f.oauth,
			getProviderAuth: t.mock.fn(async () => ({ auth: { apiKey: f.token } })),
		},
		ui: {
			notify() {},
			setWidget(_key, factory) {
				f.widget?.dispose();
				f.widget = factory?.({ requestRender() {} }, {
					fg: (_color, text) => text, bg: (_color, text) => text,
				});
			},
			onTerminalInput(handler) { f.input = handler; return () => { f.input = undefined; }; },
		},
	};
	f.pi = {
		on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(name, command) { commands.set(name, command); },
		appendEntry(customType, data) { f.branch.push({ type: "custom", customType, data }); },
		getSettings: () => ({}),
	};
	f.emit = async (name, event = {}) => {
		let result;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, f.ctx);
		await flush();
		return result;
	};
	f.command = async (name, args = "") => { await commands.get(name).handler(args, f.ctx); await flush(); };
	f.request = async payload => {
		const model = f.ctx.model ?? {};
		const prepared = await f.runtime.prepareRequest(model);
		const replacement = await prepared.options.onPayload?.(payload, model);
		return replacement === undefined ? payload : replacement;
	};
	f.key = async data => { assert.ok(f.input, "panel is open"); f.input(data); await flush(); };
	f.turns = async count => { for (let i = 0; i < count; i++) await f.emit("agent_settled"); };
	t.after(() => f.emit("session_shutdown"));
	return f;
}

function usageFixture(t) {
	const f = fixture(t);
	f.ctx.mode = "tui";
	f.panelText = () => f.widget.render(140).join("\n");
	registerUsage(f.pi);
	return f;
}

test("parses windows by duration, clamps percentages, and normalizes resets", () => {
	const data = payload();
	data.rate_limit = {
		allowed: false,
		primary_window: { limit_window_seconds: 604800, used_percent: 120, reset_at: 200 },
		secondary_window: { limit_window_seconds: 18000, used_percent: -5, reset_after_seconds: 10 },
	};
	const now = 100000;
	assert.deepEqual(parseUsage(data, now), {
		plan: "plus", fetchedAt: now, blocked: true,
		windows: [
			{ label: "5 hours", usedPercent: 0, resetAt: now + 10 * 1000 },
			{ label: "Weekly", usedPercent: 100, resetAt: 200 * 1000 },
		],
	});
	assert.equal(parseUsage(payload(NaN)).windows[0].usedPercent, undefined);
	assert.throws(() => parseUsage({}), UsageError);
	assert.throws(() => parseUsage({ plan_type: "free" }), UsageError);
});

test("fetches with refreshed Codex credentials, account header, and caller signal", async t => {
	const f = fixture(t);
	const signal = new AbortController().signal;
	const result = await fetchUsage(f.ctx, signal);
	assert.equal(result.windows[0].usedPercent, 20);
	assert.deepEqual(f.ctx.modelRegistry.getProviderAuth.mock.calls[0].arguments, ["openai-codex"]);
	assert.deepEqual(f.requests, [{
		url: "https://chatgpt.com/backend-api/wham/usage",
		headers: { Authorization: `Bearer ${f.token}`, "ChatGPT-Account-Id": "test-account", Accept: "application/json" },
		signal, redirect: "error", cache: "no-store",
	}]);
});

test("rejects unsupported auth and invalid tokens before making any request", async t => {
	const f = fixture(t);
	const fetch = () => fetchUsage(f.ctx, new AbortController().signal);
	f.oauth = false;
	await assert.rejects(fetch, UsageError);
	f.oauth = true;
	f.models = [{ provider: "openai" }];
	await assert.rejects(fetch, /newer openai|same ChatGPT account/i);
	f.models = [{ provider: "openai-codex" }];
	for (const token of [undefined, "not-a-jwt", jwt(undefined), jwt("bad\r\naccount")]) {
		f.token = token;
		await assert.rejects(fetch, UsageError);
	}
	f.ctx.modelRegistry.getProviderAuth = async () => { throw new Error("secret-auth-detail"); };
	await assert.rejects(fetch, error => error instanceof UsageError && !error.message.includes("secret-auth-detail"));
	assert.equal(f.requests.length, 0);
});

test("sanitizes HTTP failures without exposing response bodies", async t => {
	const f = fixture(t);
	for (const [status, message] of [[401, /rejected/], [403, /rejected/], [429, /rate-limited/], [500, /HTTP 500/]]) {
		const response = new Response("secret-response-body", { status });
		f.respond = () => response;
		await assert.rejects(() => fetchUsage(f.ctx, new AbortController().signal), error => {
			assert.ok(error instanceof UsageError);
			assert.match(error.message, message);
			assert.doesNotMatch(error.message, /secret-response-body/);
			return true;
		});
		assert.equal(response.bodyUsed, true, "error response body was cancelled");
	}
});

test("already-aborted fetches never reach the usage endpoint", async t => {
	const f = fixture(t);
	await assert.rejects(() => fetchUsage(f.ctx, AbortSignal.abort()), { name: "AbortError" });
	assert.equal(f.requests.length, 0);
});

test("fetches only when opening usage or pressing r, never on agent turns", async t => {
	const f = usageFixture(t);
	await f.turns(5);
	assert.equal(f.requests.length, 0);
	await f.command("usage");
	assert.equal(f.requests.length, 1);
	assert.match(f.panelText(), /80% left/);
	assert.doesNotMatch(f.panelText(), /pin|footer/i);
	assert.equal(f.input("p"), undefined, "p is no longer consumed");
	await f.command("usage");
	await f.emit("turn_end");
	await f.emit("agent_end");
	await f.turns(10);
	assert.equal(f.requests.length, 1, "an open panel does not automatically refresh");
	await f.key("\x1b[114;1:1u");
	await f.key("\x1b[114;1:2u");
	await f.key("\x1b[114;1:3u");
	assert.equal(f.requests.length, 2, "r acts only on key press, not repeat/release");
	await f.key("\x1b");
	await f.turns(5);
	assert.equal(f.requests.length, 2);
	await f.command("usage");
	assert.equal(f.requests.length, 3);
});

test("deduplicates manual refreshes and recovers from HTTP/network failures", async t => {
	const f = usageFixture(t);
	await f.command("usage");
	let finish;
	f.respond = () => new Promise(resolve => { finish = resolve; });
	await f.key("r");
	assert.match(f.panelText(), /Fetching subscription limits/);
	await f.key("r");
	assert.equal(f.requests.length, 2);
	finish(new Response("private error", { status: 500 }));
	await flush();
	assert.match(f.panelText(), /HTTP 500/);
	assert.doesNotMatch(f.panelText(), /private error|Fetching subscription limits/);
	f.respond = () => { throw new Error("private network detail"); };
	await f.key("r");
	assert.match(f.panelText(), /Could not load usage/);
	assert.doesNotMatch(f.panelText(), /private network detail/);
	f.respond = () => Response.json(payload(40));
	await f.key("r");
	assert.match(f.panelText(), /60% left/);
	assert.doesNotMatch(f.panelText(), /Could not load usage/);
});

test("closing or shutting down cancels requests; late responses cannot affect a new panel", async t => {
	const f = usageFixture(t);
	for (const close of [() => f.key("\x1b"), () => f.emit("session_shutdown")]) {
		let finish;
		f.respond = () => new Promise(resolve => { finish = resolve; });
		await f.command("usage");
		const request = f.requests.at(-1);
		await close();
		assert.equal(request.signal.aborted, true);
		assert.equal(f.widget, undefined);
		assert.equal(f.input, undefined);
		await f.emit("session_start");
		f.respond = () => Response.json(payload(40));
		await f.command("usage");
		finish(Response.json(payload(99)));
		await flush();
		assert.match(f.panelText(), /60% left/);
		await f.key("\x1b");
	}
});

test("priority is opt-in, preserves payloads, and only affects supported models", async t => {
	const f = fixture(t);
	register(f.pi);
	const payload = Object.freeze({ input: ["fixture"], stream: true, service_tier: "auto" });
	const request = () => f.request(payload);
	assert.equal(await request(), payload);
	for (const provider of ["openai", "openai-codex"]) {
		for (const api of ["openai-responses", "openai-codex-responses", "openai-completions"]) {
			f.ctx.model = { provider, api };
			await f.command("fast", "on");
			assert.deepEqual(await request(), { ...payload, service_tier: "priority" });
			assert.equal(payload.service_tier, "auto", "original payload was not mutated");
		}
	}
	for (const model of [undefined, { provider: "other", api: "openai-responses" }, { provider: "openai", api: "other" }]) {
		f.ctx.model = model;
		assert.equal(await request(), payload);
	}
	f.ctx.model = f.models[0];
	for (const invalid of [null, [], "not-an-object"]) {
		assert.equal(await f.request(invalid), invalid);
	}
	await f.command("fast", "off");
	assert.equal(await request(), payload);
	f.ctx.model = { provider: "other", api: "openai-responses" };
	await f.command("fast", "on");
	f.ctx.model = f.models[0];
	assert.equal(await request(), payload, "unsupported model could not enable priority");
});

test("priority starts off for all session starts and never restores or writes saved fast state", async t => {
	const f = fixture(t);
	register(f.pi);
	const payload = { input: [] };
	const request = () => f.request(payload);
	const saved = { type: "custom", customType: "pi-openai:fast", data: { enabled: true } };
	for (const reason of ["startup", "new", "resume", "reload", "fork"]) {
		f.branch = reason === "new" ? [] : [saved];
		const before = structuredClone(f.branch);
		await f.command("fast", "on");
		assert.equal((await request()).service_tier, "priority");
		assert.deepEqual(f.branch, before, "fast state must not be persisted");
		await f.emit("session_start", { reason });
		await f.command("fast", "status");
		assert.equal(await request(), payload, reason);
		await f.emit("session_tree");
		assert.equal(await request(), payload, "branch history cannot re-enable fast mode");
	}
});

test("red model label tracks the live priority gate and resets to Pi's native footer", async t => {
	const { FooterComponent } = await import(path.join(root, "dist/index.js"));
	const { initTheme, theme } = await import(path.join(root, "dist/modes/interactive/theme/theme.js"));
	const { rgbColor, stripTerminalSequences } = await import(path.join(root, "node_modules/@earendil-works/pi-tui/dist/index.js"));
	initTheme("dark");
	const f = fixture(t);
	f.ctx.mode = "tui";
	f.oauth = false;
	f.ctx.model = { ...f.models[0], reasoning: true, contextWindow: 128000 };
	f.ctx.thinkingLevel = "high";
	Object.assign(f.ctx.sessionManager, {
		getEntries: () => f.branch, getEntryCount: () => f.branch.length,
		getSessionId: () => "footer-test", getLeafId: () => "leaf",
		getCwd: () => "/tmp/fixture", getSessionName: () => "",
	});
	f.ctx.getContextUsage = () => ({ percent: 1, contextWindow: 128000 });
	let watchers = 0;
	const footerData = {
		getGitBranch: () => "main", getAvailableProviderCount: () => 2,
		getExtensionStatuses: () => new Map([["other", "other extension status"]]),
		onBranchChange() { watchers++; return () => { watchers--; }; },
	};
	const native = new FooterComponent({
		get state() { return { model: f.ctx.model, thinkingLevel: f.ctx.thinkingLevel }; },
		get model() { return f.ctx.model; },
		sessionManager: f.ctx.sessionManager, getContextUsage: f.ctx.getContextUsage,
		modelRuntime: { isUsingSubscription: () => false },
	}, footerData);
	f.ctx.ui.setFooter = factory => {
		f.footer?.dispose();
		f.footer = factory?.({ requestRender() {} }, theme, footerData);
	};
	register(f.pi);
	const payload = {};
	const request = () => f.request(payload);
	const assertRed = async () => {
		assert.equal((await request()).service_tier, "priority");
		const lines = f.footer.render(160), baseline = native.render(160);
		assert.deepEqual(lines.map(stripTerminalSequences), baseline.map(stripTerminalSequences));
		assert.equal(lines[0], baseline[0]);
		assert.equal(lines[2], baseline[2]);
		const label = `(${f.ctx.model.provider}) fixture • ${f.ctx.thinkingLevel}`;
		assert.ok(lines[1].endsWith(theme.style(label, { fg: rgbColor(255, 0, 0) })));
	};
	const assertOff = async () => {
		assert.equal(await request(), payload);
		assert.equal(f.footer, undefined, "Pi's built-in footer is restored");
		assert.equal(watchers, 0);
	};
	await assertOff();
	await f.command("fast", "on");
	await assertRed();
	f.ctx.thinkingLevel = "low";
	await assertRed();
	const supported = f.ctx.model;
	f.ctx.model = { ...supported, provider: "other" };
	assert.deepEqual(f.footer.render(160), native.render(160), "no stale red before model_select");
	await f.emit("model_select");
	await assertOff();
	f.ctx.model = supported;
	await f.emit("model_select");
	await assertRed();
	await f.command("fast", "off");
	await assertOff();
	for (const reason of ["new", "resume"]) {
		await f.command("fast", "on");
		await assertRed();
		await f.emit("session_start", { reason });
		await assertOff();
	}
});
