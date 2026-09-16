import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	formatSkillsForPrompt,
	getAgentDir,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
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

function readPrompt(path: string, baseDir: string): string {
	const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	return readFileSync(resolve(baseDir, expanded), "utf8");
}

// Pi 0.85's context/skills suffix. Keep the native base instructions opaque.
function contextSuffix(options: BuildSystemPromptOptions): string {
	let suffix = "";
	if (options.contextFiles?.length) {
		suffix += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
		for (const { path, content } of options.contextFiles) {
			suffix += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
		}
		suffix += "</project_context>\n";
	}
	const tools = options.selectedTools ?? ["read", "bash", "edit", "write"];
	const readTool = (["read", "bash"] as const).find((tool) => tools.includes(tool));
	if (readTool && options.skills?.length) suffix += formatSkillsForPrompt(options.skills, readTool);
	suffix += `\nCurrent working directory: ${options.cwd.replace(/\\/g, "/")}`;
	if (options.customPrompt) suffix += "\n";
	return suffix;
}

export default function modelSystemPrompt(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		if (!ctx.model) return;
		try {
			const globalRules = loadRules(join(getAgentDir(), "settings.json"));
			const projectRules = ctx.isProjectTrusted()
				? loadRules(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
				: [];
			const id = `${ctx.model.provider}/${ctx.model.id}`;
			const rule = [...projectRules, ...globalRules].find((entry) => matches(entry.pattern, id));
			if (!rule) return;

			const options = event.systemPromptOptions;
			const oldSuffix = contextSuffix(options);
			const boundary = event.systemPrompt.lastIndexOf(oldSuffix);
			if (boundary < 0) throw new Error("Cannot identify Pi's context suffix; leaving prompt unchanged");
			let base = event.systemPrompt.slice(0, boundary);
			const trailing = event.systemPrompt.slice(boundary + oldSuffix.length);
			const oldAppend = options.appendSystemPrompt ? `\n\n${options.appendSystemPrompt}` : "";
			if (oldAppend && !base.endsWith(oldAppend)) {
				throw new Error("Another extension changed the append section; leaving prompt unchanged");
			}
			if (oldAppend) base = base.slice(0, -oldAppend.length);

			const customPath = rule.files["SYSTEM.md"];
			const appendPath = rule.files["APPEND_SYSTEM.md"];
			const custom = customPath === undefined ? options.customPrompt : readPrompt(customPath, rule.baseDir);
			if (customPath !== undefined) {
				if (!custom?.trim()) throw new Error(`Empty SYSTEM.md: ${customPath}`);
				base = custom;
			}
			const append = appendPath === undefined ? options.appendSystemPrompt : readPrompt(appendPath, rule.baseDir);
			return {
				systemPrompt: base + (append ? `\n\n${append}` : "")
					+ contextSuffix({ ...options, customPrompt: custom }) + trailing,
			};
		} catch (error) {
			const message = `model-system-prompt: ${error instanceof Error ? error.message : String(error)}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else console.error(message);
		}
	});
}
