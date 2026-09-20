import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Mapping = { "SYSTEM.md"?: string; "APPEND_SYSTEM.md"?: string };
type Rule = { pattern: string; files: Mapping; baseDir: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadRules(path: string): Rule[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const settings = JSON.parse(text.replace(/^\uFEFF/, ""));
	if (!isRecord(settings)) throw new Error(`Expected an object in ${path}`);
	if (settings.systemPromptMap === undefined) return [];
	if (!isRecord(settings.systemPromptMap)) throw new Error(`Invalid systemPromptMap in ${path}`);
	return Object.entries(settings.systemPromptMap).map(([pattern, files]) => {
		if (!pattern || !isRecord(files) || Object.keys(files).length === 0) {
			throw new Error(`Invalid systemPromptMap entry ${pattern} in ${path}`);
		}
		for (const [key, value] of Object.entries(files)) {
			if (!["SYSTEM.md", "APPEND_SYSTEM.md"].includes(key) || typeof value !== "string" || !value.trim()) {
				throw new Error(`Invalid ${pattern}.${key} in ${path}`);
			}
		}
		return { pattern, files: files as Mapping, baseDir: dirname(path) };
	});
}

function matches(pattern: string, model: string): boolean {
	const regex = pattern.split("").map((char) => {
		if (char === "*") return ".*";
		if (char === "?") return ".";
		return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}).join("");
	return new RegExp(`^${regex}$`).test(model);
}

function getRule(ctx: ExtensionContext): Rule | undefined {
	if (!ctx.model) return;
	const globalRules = loadRules(join(getAgentDir(), "settings.json"));
	const projectRules = ctx.isProjectTrusted()
		? loadRules(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
		: [];
	const id = `${ctx.model.provider}/${ctx.model.id}`;
	return [...projectRules, ...globalRules].find((entry) => matches(entry.pattern, id));
}

function readPrompt(path: string, baseDir: string): string {
	const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	return readFileSync(resolve(baseDir, expanded), "utf8");
}

export default function modelSystemPrompt(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" || ctx.mode !== "tui") return;
		try {
			const rule = getRule(ctx);
			if (!rule) return;
			const mappings = Object.entries(rule.files).map(([section, path]) => `${section} → ${path}`);
			ctx.ui.notify(`Prompt override: ${mappings.join(", ")}`, "info");
		} catch (error) {
			ctx.ui.notify(`model-system-prompt: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		try {
			const rule = getRule(ctx);
			if (!rule) return;

			const options = event.systemPromptOptions;
			if (options.forceSystemPrompt !== undefined) {
				throw new Error("Another extension forced the system prompt; leaving prompt unchanged");
			}

			const customPath = rule.files["SYSTEM.md"];
			const appendPath = rule.files["APPEND_SYSTEM.md"];
			const custom = customPath === undefined ? options.customPrompt : readPrompt(customPath, rule.baseDir);
			if (customPath !== undefined && !custom?.trim()) throw new Error(`Empty SYSTEM.md: ${customPath}`);
			const append = appendPath === undefined ? options.appendSystemPrompt : readPrompt(appendPath, rule.baseDir);
			if (customPath !== undefined) options.customPrompt = custom;
			if (appendPath !== undefined) options.appendSystemPrompt = append;
		} catch (error) {
			const message = `model-system-prompt: ${error instanceof Error ? error.message : String(error)}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else console.error(message);
		}
	});
}
