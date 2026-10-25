// Run against installed Pi with `npm test`; set PI_ROOT to test another built release.
// Native output is the oracle: no version-pinned snapshots or copied preview limits.
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { click, harness, piRoot, sdk, text, theme, tui } from "./harness.mjs";

console.log(`Compatibility target: Pi ${sdk.VERSION} (${piRoot})`);
const output = Array.from({ length: 30 }, (_, index) => `output-line-${index}`).join("\n");
const result = {
	content: [{ type: "text", text: output }], details: undefined,
	isError: false, durationMs: 125,
};

for (const themeName of ["dark", "light"]) {
	test(`installed Pi: native rendering and mouse dispatch contract (${themeName})`, async (t) => {
		sdk.initTheme(themeName);
		const h = await harness(t);
		const native = sdk.createBashToolDefinition(process.cwd());
		for (const isError of [false, true]) {
			const row = h.row(`shorter-${isError}`);
			const sibling = h.row(`sibling-${isError}`);
			const reference = h.row(`native-${isError}`, native);
			for (const component of [row, sibling, reference]) component.updateResult({ ...result, isError });
			const short = row.render(80);
			assert(short.join("\n").includes(theme.fg(isError ? "error" : "success", "bash")));
			const siblingBefore = sibling.render(80);

			click(row, /bash/);
			for (const width of [32, 80, 120]) {
				assert.deepEqual(row.render(width), reference.render(width), "Native preview framing/content drifted");
			}
			assert.deepEqual(sibling.render(80), siblingBefore, "Click changed a different call");
			// Click the result slot, not just the command header.
			click(row, /output-line-29/);
			reference.setExpanded(true);
			for (const width of [32, 80, 120]) {
				assert.deepEqual(row.render(width), reference.render(width), "Native expanded output drifted");
			}
			click(row, /output-line-0\b/);
			assert.deepEqual(row.render(80), short, "Third click did not restore short view");

			click(row, /bash/);
			h.expand(true);
			assert.deepEqual(row.render(80), reference.render(80), "Ctrl+O did not override local preview");
			h.expand(false);
			assert.deepEqual(row.render(80), short, "Ctrl+O did not clear the local view override");
		}
	});
}

test("upstream adds colliding renderer fields and changes cached component types", async (t) => {
	sdk.initTheme("dark");
	const states = new Set();
	const callComponents = new WeakSet();
	const resultComponents = new WeakSet();
	const collision = { nativeState: "upstream", nativeCall: "upstream", nativeResult: "upstream", box: "upstream" };
	const intervalMetadata = { purpose: "upstream no longer stores a timer here" };
	const renders = { call: 0, result: 0 };
	function render(context, slot) {
		const ownComponents = slot === "call" ? callComponents : resultComponents;
		if (!states.has(context.state)) {
			assert.deepEqual(Object.keys(context.state), [], "Wrapper fields leaked into native renderer state");
			Object.assign(context.state, collision, { interval: intervalMetadata });
			states.add(context.state);
		}
		for (const [key, value] of Object.entries(collision)) assert.equal(context.state[key], value);
		if (context.lastComponent) {
			assert(ownComponents.has(context.lastComponent), "Native cache was replaced by a wrapper or the other slot");
		}
		// A renderer is allowed to replace its previous Text with a different component type.
		const component = ++renders[slot] % 2 ? new tui.Text(`native-${slot}`, 0, 0) : new tui.Container();
		if (component instanceof tui.Container) component.addChild(new tui.Text(`native-${slot}`, 0, 0));
		ownComponents.add(component);
		return component;
	}
	const h = await harness(t, (base) => ({
		...base,
		renderCall: (_args, _theme, context) => render(context, "call"),
		renderResult: (_result, _options, _theme, context) => render(context, "result"),
	}));
	h.expand(true);
	for (const id of ["a", "b"]) {
		const context = h.context(id);
		for (let pass = 0; pass < 3; pass++) {
			const call = h.tool.renderCall(context.args, theme, context);
			const response = h.tool.renderResult(result, { expanded: true, isPartial: false }, theme, context);
			assert.match(text(call), /native-call/);
			assert.match(text(response), /native-result/);
		}
		assert(!states.has(context.state), "Native and extension state must be separate objects");
	}
	assert.equal(states.size, 2, "Native state leaked between calls");
	await h.emit("session_shutdown");
	for (const state of states) {
		assert.equal(state.interval, intervalMetadata, "Cleanup modified an unrecognized upstream field");
	}
});

test("host renders the result first and later updates slots independently", async (t) => {
	sdk.initTheme("dark");
	const h = await harness(t);
	h.expand(true);
	const context = h.context("result-first");
	const response = h.tool.renderResult(result, { expanded: true, isPartial: false }, theme, context);
	assert.match(text(response), /output-line-0\b/, "Result cannot depend on renderCall running first");
	const call = h.tool.renderCall(context.args, theme, context);
	const callBefore = call.render(80);
	assert.match(text(call), /\$ printf example/);
	assert.doesNotMatch(text(call), /output-line-/, "Result content was hoisted into the call slot");
	const updated = h.tool.renderResult({ ...result, content: [{ type: "text", text: "replacement output" }] },
		{ expanded: true, isPartial: false }, theme, context);
	assert.match(text(updated), /replacement output/);
	assert.deepEqual(call.render(80), callBefore, "Result renderer mutated the call's component tree");
	const resultBefore = updated.render(80);
	h.tool.renderCall({ ...context.args, command: "printf changed" }, theme, context);
	assert.deepEqual(updated.render(80), resultBefore, "Call renderer mutated the result's component tree");
});

test("upstream switches bash to self-framed rendering", async (t) => {
	sdk.initTheme("dark");
	const h = await harness(t, (base) => ({
		...base,
		renderShell: "self",
		renderCall: () => new tui.Text("[upstream call frame]", 0, 0),
		renderResult: () => new tui.Text("[upstream result frame]", 0, 0),
	}));
	h.expand(true);
	const context = h.context("self-framed");
	assert.deepEqual(h.tool.renderCall(context.args, theme, context).render(80),
		h.base.renderCall(context.args, theme, context).render(80));
	assert.deepEqual(h.tool.renderResult(result, { expanded: true, isPartial: false }, theme, context).render(80),
		h.base.renderResult(result, { expanded: true, isPartial: false }, theme, context).render(80),
		"Extension added a second shell around native framing");
});

test("upstream execution and new metadata pass through without an adapter", async (t) => {
	const update = { content: [], details: { futureProgress: "working" } };
	const answer = { ...result, futureResultField: { preserved: true } };
	let received;
	const h = await harness(t, (base) => ({
		...base,
		futureToolMetadata: { native: true },
		async execute(...input) {
			received = input;
			input[3](update);
			return answer;
		},
	}));
	assert.equal(h.tool.execute, h.base.execute, "Execution must remain the upstream function itself");
	assert.equal(h.tool.outputSchema, h.base.outputSchema);
	assert.equal(h.tool.futureToolMetadata, h.base.futureToolMetadata);
	const signal = new AbortController().signal;
	const args = { command: "unused", description: "Check native delegation" };
	const context = { nativeSession: true };
	let observedUpdate;
	const onUpdate = (value) => { observedUpdate = value; };
	assert.equal(await h.tool.execute("future", args, signal, onUpdate, context), answer);
	assert.deepEqual(received, ["future", args, signal, onUpdate, context]);
	assert.equal(observedUpdate, update);
});

test("installed Pi: renderer timers are released at every teardown boundary", async (t) => {
	for (const boundary of ["session_tree", "session_compact", "session_shutdown"]) {
		await t.test(boundary, async (t) => {
			sdk.initTheme("dark");
			const h = await harness(t);
			const live = new Set();
			const resources = new Set();
			let capture = false;
			// Observe actual resources, not the current native state's interval field name.
			const hook = createHook({
				init(id, type, _triggerId, resource) {
					if (capture && type === "Timeout") { live.add(id); resources.add(resource); }
				},
				destroy(id) { live.delete(id); },
			});
			t.after(() => {
				hook.disable();
				// A failing compatibility check must not leave the test runner alive.
				for (const timer of resources) clearTimeout(timer);
			});
			hook.enable();
			capture = true;
			try {
				const row = h.row("streaming");
				row.markExecutionStarted();
				row.updateResult({ content: [{ type: "text", text: "partial output" }], isError: false }, true);
				click(row, /bash/);
			} finally {
				capture = false;
			}
			await h.emit(boundary);
			await nextTurn();
			assert.equal(live.size, 0, `Native timer ownership changed: ${boundary} leaked renderer timers`);
			// Repeated cleanup must be harmless.
			await h.emit(boundary);
		});
	}
});
