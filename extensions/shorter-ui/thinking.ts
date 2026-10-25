import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

type Message = Parameters<AssistantMessageComponent["updateContent"]>[0];

function previews(message: Message): string[] {
	const lines: string[] = [];
	let current: string | undefined;
	for (const block of message.content) {
		if (block.type === "thinking") {
			if (!block.thinking.trim()) continue;
			const text = stripVTControlCharacters(block.thinking).trimEnd();
			current = text.slice(Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1)
				.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
		} else if (current !== undefined) {
			lines.push(current);
			current = undefined;
		}
	}
	if (current !== undefined) lines.push(current);
	return lines;
}

function thinkingRegions(container: Container): MouseRegion[] {
	return container.children.flatMap((child) => child instanceof MouseRegion ? [child]
		: child instanceof Container ? thinkingRegions(child) : []);
}

/**
 * Pi has no collapsed-thinking renderer hook. Keep the compatibility adapter here:
 * use its exported component methods and guard the one private field (MouseRegion.child).
 * Unknown layouts fall back to native rendering; expanded Markdown is never changed.
 */
export function installRollingThinking(getTheme: () => Theme, getPadding: () => number): () => void {
	const prototype = AssistantMessageComponent.prototype;
	const originalUpdate = prototype.updateContent;
	const originalRender = prototype.render;
	const initialized = new WeakSet<AssistantMessageComponent>();
	let active = true;

	function update(this: AssistantMessageComponent, ...args: Parameters<typeof originalUpdate>): void {
		originalUpdate.apply(this, args);
		if (!active) return;
		initialized.add(this);
		const lines = previews(args[0]);
		const regions = thinkingRegions(this);
		const children = regions.map((region) => (region as unknown as { child?: Component }).child);
		// Each native thinking run has one mouse region, containing Text when collapsed.
		if (regions.length !== lines.length ||
			children.some((child) => !(child instanceof Text) && !(child instanceof Markdown))) return;

		regions.forEach((region, index) => {
			if (!(children[index] instanceof Text)) return;
			const nativeRender = region.render;
			region.render = function (width) {
				if (!active) return nativeRender.call(this, width);
				if (width <= 0) return [];
				const pad = " ".repeat(Math.min(getPadding(), Math.max(0, width - 1)));
				const theme = getTheme();
				const text = theme.italic(theme.fg("thinkingText", lines[index] || "Thinking..."));
				return [truncateToWidth(pad + text, width)];
			};
		});
	}

	function render(this: AssistantMessageComponent, width: number): string[] {
		// /reload can construct transcript components before session_start installs us.
		// Public invalidation rebuilds those components through the update adapter once.
		if (active && !initialized.has(this)) {
			initialized.add(this);
			this.invalidate();
		}
		return originalRender.call(this, width);
	}

	prototype.updateContent = update;
	prototype.render = render;
	return () => {
		active = false;
		// Do not overwrite another extension's later wrapper. Ours becomes a pass-through.
		if (prototype.updateContent === update) prototype.updateContent = originalUpdate;
		if (prototype.render === render) prototype.render = originalRender;
	};
}
