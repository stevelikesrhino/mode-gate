/**
 * Bash command safety patterns for mode-gate extension.
 */

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bdel\b/i,
	/\berase\b/i,
	/\bmv\b/i,
	/\bmove\b/i,
	/\bcp\b/i,
	/\bcopy\b/i,
	/\bmkdir\b/i,
	/\bmd\b/i,
	/\btouch\b/i,
	/\bren\b/i,
	/\brename\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\bsed\b(?=[^\n;&|]*\s(?:-[^\s-]*i[^\s]*|--in-place(?:=|\s|$)))/i,
	/\bremove-item\b/i,
	/\bset-content\b/i,
	/\badd-content\b/i,
	/\bout-file\b/i,
	/\bnew-item\b/i,
	/\bcopy-item\b/i,
	/\bmove-item\b/i,
	/\brename-item\b/i,
	/\bclear-content\b/i,
	/\binvoke-expression\b/i,
	/\biex\b/i,
	/\bstart-process\b/i,
	/\bset-item\b/i,
	/\bperl\b.*-[ip]/i,
	/\bpatch\b/i,
	/\binstall\b/i,
	/\bcurl\b.*-[oO]\s/i,
	/\bwget\b(?!\s+-O\s*-)/i,
	/\bcat\s*<<.*>/i,
	/\bnode\s+-e\b.*fs\./i,
	/\bruby\s+-e\b.*File\./i,
];

type Redirection =
	| { kind: "file"; fd?: string; operator: "<" | ">" | ">>"; target: string }
	| { kind: "dup"; fd?: string; operator: ">&" | "<&"; target: string };

type Segment = {
	argv: string[];
	redirections: Redirection[];
};

const SIMPLE_SAFE_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"grep",
	"find",
	"ls",
	"pwd",
	"echo",
	"printf",
	"wc",
	"sort",
	"uniq",
	"diff",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"which",
	"whereis",
	"type",
	"printenv",
	"uname",
	"whoami",
	"id",
	"date",
	"cal",
	"uptime",
	"ps",
	"top",
	"htop",
	"free",
	"jq",
	"awk",
	"rg",
	"fd",
	"bat",
	"exa",
	"cd",
	"od",
	"dir",
	"type",
	"where",
	"findstr",
	"fc",
	"get-childitem",
	"get-content",
	"select-string",
	"measure-object",
	"get-location",
	"get-date",
	"get-process",
	"get-command",
	"get-help",
	"resolve-path",
	"test-path",
]);

const SHELL_SEPARATORS = new Set(["|", "&&", "||", ";"]);
const GIT_BRANCH_UNSAFE_FLAGS = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy"]);
const GIT_BRANCH_SAFE_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--all", "--remotes", "--verbose", "--show-current", "--list", "--contains", "--no-contains", "--merged", "--no-merged"]);
const CURL_OUTPUT_FLAG_RE = /^-[^-\s]*[oO][^-\s]*$/;
const DUP_REDIRECTION_TARGET_RE = /^(?:\d+|-)$/;

function isEscaped(command: string, index: number): boolean {
	let slashCount = 0;
	for (let i = index - 1; i >= 0 && command[i] === "\\"; i--) {
		slashCount++;
	}
	return slashCount % 2 === 1;
}

function containsUnsafeExpansion(command: string): boolean {
	let quote: "'" | '"' | undefined;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];

		if (quote) {
			if (char === quote && !isEscaped(command, i)) {
				quote = undefined;
				continue;
			}
			if (quote === '"' && char === "\\" && next) {
				i++;
				continue;
			}
			if (quote !== "'" && char === "`" && !isEscaped(command, i)) return true;
			if (quote !== "'" && char === "$" && next === "(" && !isEscaped(command, i)) return true;
			continue;
		}

		if ((char === "'" || char === '"') && !isEscaped(command, i)) {
			quote = char;
			continue;
		}
		if (char === "`" && !isEscaped(command, i)) return true;
		if (char === "$" && next === "(" && !isEscaped(command, i)) return true;
	}

	return false;
}

function tokenize(command: string): string[] | undefined {
	const tokens: string[] = [];
	let buffer = "";
	let quote: "'" | '"' | undefined;

	function flushBuffer() {
		if (buffer) {
			tokens.push(buffer);
			buffer = "";
		}
	}

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else if (quote === '"' && char === "\\" && next) {
				buffer += next;
				i++;
			} else {
				buffer += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (char === "\n" || char === "\r") {
			flushBuffer();
			const previous = tokens[tokens.length - 1];
			if (!previous || SHELL_SEPARATORS.has(previous)) continue;

			const hasMore = command.slice(i + 1).split("").some((remaining) => !/\s/.test(remaining));
			if (hasMore) tokens.push(";");
			continue;
		}

		if (/\s/.test(char)) {
			flushBuffer();
			continue;
		}

		if (char === "|" || char === "&" || char === ";") {
			flushBuffer();
			if ((char === "|" || char === "&") && next === char) {
				tokens.push(char + next);
				i++;
			} else if (char === "|") {
				tokens.push(char);
			} else if (char === ";") {
				tokens.push(char);
			} else {
				return undefined;
			}
			continue;
		}

		if (char === "<" || char === ">") {
			const fd = /^\d+$/.test(buffer) ? buffer : "";
			if (fd) buffer = "";
			flushBuffer();

			if (next === "<") return undefined;

			if (next === "&") {
				let target = "";
				i += 2;
				while (i < command.length && !/\s/.test(command[i]) && !/[|&;<>]/.test(command[i])) {
					target += command[i];
					i++;
				}
				i--;
				if (!target) return undefined;
				tokens.push(`${fd}${char}&${target}`);
				continue;
			}

			const operator = char === ">" && next === ">" ? ">>" : char;
			if (operator === ">>") i++;
			tokens.push(`${fd}${operator}`);
			continue;
		}

		buffer += char;
	}

	if (quote) return undefined;
	flushBuffer();
	return tokens;
}

function parseRedirection(tokens: string[], index: number): { redirection: Redirection; nextIndex: number } | undefined {
	const token = tokens[index];
	const dupMatch = token.match(/^(\d*)(>&|<&)(.+)$/);
	if (dupMatch) {
		return {
			redirection: {
				kind: "dup",
				fd: dupMatch[1] || undefined,
				operator: dupMatch[2] as ">&" | "<&",
				target: dupMatch[3],
			},
			nextIndex: index + 1,
		};
	}

	const fileMatch = token.match(/^(\d*)(>>|>|<)(.*)$/);
	if (!fileMatch) return undefined;

	const [, fd, operator, inlineTarget] = fileMatch;
	const target = inlineTarget || tokens[index + 1];
	if (!target || SHELL_SEPARATORS.has(target)) return undefined;

	return {
		redirection: {
			kind: "file",
			fd: fd || undefined,
			operator: operator as "<" | ">" | ">>",
			target,
		},
		nextIndex: inlineTarget ? index + 1 : index + 2,
	};
}

function parseSegments(command: string): Segment[] | undefined {
	const tokens = tokenize(command);
	if (!tokens || tokens.length === 0) return undefined;

	const segments: Segment[] = [];
	let current: Segment = { argv: [], redirections: [] };

	for (let index = 0; index < tokens.length;) {
		const token = tokens[index];

		if (SHELL_SEPARATORS.has(token)) {
			if (current.argv.length === 0) return undefined;
			segments.push(current);
			current = { argv: [], redirections: [] };
			index++;
			continue;
		}

		const redirection = parseRedirection(tokens, index);
		if (redirection) {
			current.redirections.push(redirection.redirection);
			index = redirection.nextIndex;
			continue;
		}

		current.argv.push(token);
		index++;
	}

	if (current.argv.length === 0) return undefined;
	segments.push(current);
	return segments;
}

function isSafeGit(args: string[]): boolean {
	const [subcommand, ...rest] = args;
	if (!subcommand) return false;

	if (subcommand === "status" || subcommand === "log" || subcommand === "diff" || subcommand === "show") return true;
	if (subcommand.startsWith("ls-")) return true;
	if (subcommand === "branch") {
		if (rest.some((arg) => GIT_BRANCH_UNSAFE_FLAGS.has(arg))) return false;
		if (rest.length === 0) return true;

		let listMode = false;
		for (const arg of rest) {
			if (arg === "--list") {
				listMode = true;
				continue;
			}
			if (GIT_BRANCH_SAFE_FLAGS.has(arg)) continue;
			if (!arg.startsWith("-") && listMode) continue;
			return false;
		}
		return true;
	}
	if (subcommand === "remote") {
		return rest.length === 0 || (rest[0] === "-v") || (rest[0] === "show") || (rest[0] === "get-url");
	}
	if (subcommand === "config") return rest[0] === "--get";
	return false;
}

function isSafeNpm(args: string[]): boolean {
	const [subcommand, ...rest] = args;
	if (!["list", "ls", "view", "info", "search", "outdated", "audit"].includes(subcommand ?? "")) return false;
	if (subcommand === "audit" && rest.includes("fix")) return false;
	return true;
}

function isSafeYarn(args: string[]): boolean {
	return ["list", "info", "why", "audit"].includes(args[0] ?? "");
}

function isSafeEnv(args: string[]): boolean {
	return args.every((arg) => arg.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(arg));
}

function isSafeCurl(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-o" || arg === "-O" || arg === "--output" || arg === "--remote-name" || arg === "--remote-name-all") return false;
		if (arg.startsWith("--output=") || CURL_OUTPUT_FLAG_RE.test(arg)) return false;
	}
	return true;
}

function isSafeWget(args: string[]): boolean {
	return args.length >= 2 && args[0] === "-O" && args[1] === "-";
}

function isSafeSed(args: string[]): boolean {
	return args[0] === "-n" && !args.some((arg) => arg === "-i" || arg === "--in-place" || arg.startsWith("--in-place="));
}

function isSafePmset(args: string[]): boolean {
	return args[0] === "-g";
}

function isSafeOutputTarget(target: string): boolean {
	const normalizedTarget = target.trim().replace(/\\/g, "/").toLowerCase();

	return normalizedTarget === "/dev/null"
		|| normalizedTarget === "nul"
		|| normalizedTarget === "nul:"
		|| normalizedTarget.startsWith("/tmp/")
		|| normalizedTarget.startsWith("/var/tmp/")
		|| normalizedTarget.startsWith("/private/tmp/")
		|| /^[a-z]:\/temp\//.test(normalizedTarget)
		|| /^[a-z]:\/windows\/temp\//.test(normalizedTarget)
		|| normalizedTarget.startsWith("%temp%/")
		|| normalizedTarget.startsWith("%tmp%/")
		|| normalizedTarget.startsWith("$env:temp/")
		|| normalizedTarget.startsWith("$env:tmp/");
}

function isSafeSegment(segment: Segment): boolean {
	const [command, ...args] = segment.argv;
	if (!command) return false;
	const commandName = command.toLowerCase();

	const readsOnly = SIMPLE_SAFE_COMMANDS.has(commandName)
		|| (commandName === "git" && isSafeGit(args))
		|| (commandName === "npm" && isSafeNpm(args))
		|| (commandName === "yarn" && isSafeYarn(args))
		|| (commandName === "env" && isSafeEnv(args))
		|| (commandName === "curl" && isSafeCurl(args))
		|| (commandName === "wget" && isSafeWget(args))
		|| (commandName === "sed" && isSafeSed(args))
		|| (commandName === "pmset" && isSafePmset(args))
		|| ((commandName === "node" || /^python[23]?$/.test(commandName)) && args.length === 1 && args[0] === "--version");

	if (!readsOnly) return false;

	return segment.redirections.every((redirection) => {
		if (redirection.kind === "dup") return DUP_REDIRECTION_TARGET_RE.test(redirection.target);
		if (redirection.operator === "<") return true;
		return isSafeOutputTarget(redirection.target);
	});
}

export function isSafeCommand(command: string): boolean {
	if (containsUnsafeExpansion(command)) return false;
	const segments = parseSegments(command);
	return !!segments && segments.every((segment) => isSafeSegment(segment));
}

export function isDestructiveCommand(command: string): boolean {
	return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}
