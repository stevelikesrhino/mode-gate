/**
 * Bash command safety patterns for mode-gate extension.
 */

/**
 * Shell keywords that precede a command inside a segment (`if test ...`, `do cat ...`)
 * or form a segment on their own (`fi`, `done`). They are stripped before classifying.
 */
const SHELL_KEYWORDS = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "{", "}", "!", "time"]);

/**
 * Commands that are destructive whenever they are the executable of a segment.
 * Matching is on the command word only, so filenames and grep patterns never trigger this.
 */
const DESTRUCTIVE_COMMANDS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "ln", "tee", "truncate", "dd", "shred", "install", "patch",
	"chmod", "chown", "chgrp",
	"sudo", "doas", "su",
	"kill", "pkill", "killall", "reboot", "shutdown",
	"vi", "vim", "nvim", "nano", "emacs", "code", "subl",
	"sh", "bash", "zsh", "fish", "dash", "pwsh", "powershell", "cmd", "eval", "exec", "source", ".",
	// Windows / PowerShell
	"del", "erase", "move", "copy", "md", "ren", "rename",
	"remove-item", "set-content", "add-content", "out-file", "new-item", "copy-item", "move-item",
	"rename-item", "clear-content", "invoke-expression", "iex", "start-process", "set-item",
]);

/** Wrappers that run another command; the wrapped command is classified instead. */
const WRAPPER_COMMANDS = new Set(["env", "command", "builtin", "nohup", "nice", "xargs"]);

const GIT_WRITE_SUBCOMMANDS = new Set([
	"add", "commit", "push", "pull", "fetch", "merge", "rebase", "reset", "checkout", "switch", "restore", "stash",
	"cherry-pick", "revert", "tag", "init", "clone", "rm", "mv", "clean", "am", "apply", "filter-branch", "worktree",
	"submodule", "notes", "gc", "prune", "reflog",
]);
const GIT_REMOTE_WRITE_SUBCOMMANDS = new Set(["add", "remove", "rm", "rename", "set-url", "set-head", "prune", "update"]);
const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "-l", "--list"]);
/** Global git options that consume the following argument (`git -C dir push`). */
const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

const PACKAGE_WRITE_SUBCOMMANDS: Record<string, Set<string>> = {
	npm: new Set(["install", "i", "add", "uninstall", "remove", "rm", "un", "update", "up", "ci", "link", "publish", "run", "run-script", "exec", "x", "dedupe", "prune", "rebuild"]),
	pnpm: new Set(["add", "remove", "rm", "install", "i", "update", "up", "link", "publish", "run", "exec", "dlx", "dedupe", "prune", "rebuild"]),
	yarn: new Set(["add", "remove", "install", "upgrade", "publish", "run", "link", "dlx"]),
	pip: new Set(["install", "uninstall", "download"]),
	pip3: new Set(["install", "uninstall", "download"]),
	brew: new Set(["install", "uninstall", "reinstall", "upgrade", "tap", "untap", "link", "unlink", "cleanup"]),
	apt: new Set(["install", "remove", "purge", "update", "upgrade", "autoremove"]),
	"apt-get": new Set(["install", "remove", "purge", "update", "upgrade", "autoremove"]),
	systemctl: new Set(["start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask"]),
	launchctl: new Set(["load", "unload", "start", "stop", "bootstrap", "bootout", "kickstart", "remove"]),
};

const SERVICE_WRITE_ACTIONS = new Set(["start", "stop", "restart", "reload"]);
const FIND_WRITE_ACTIONS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

// Inline scripts are flagged only when the script text touches filesystem / process APIs.
const NODE_INLINE_WRITE_RE = /\b(?:fs|child_process|process\.kill)\b/;
const PYTHON_INLINE_WRITE_RE = /\b(?:open|os|subprocess|shutil|pathlib)\b/;
const RUBY_INLINE_WRITE_RE = /\b(?:File|Dir|IO|FileUtils|system|exec|spawn)\b/;
const PERL_INLINE_WRITE_RE = /\b(?:open|unlink|rename|system|exec|mkdir|rmdir)\b/;

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
	"nl",
	"test",
	"[",
	"true",
	"false",
	"read",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"tr",
	"cut",
	"paste",
	"column",
	"tac",
	"rev",
	"nproc",
	"xxd",
	"hexdump",
	"strings",
	"shasum",
	"sha256sum",
	"md5",
	"md5sum",
]);

const SHELL_SEPARATORS = new Set(["|", "&&", "||", ";"]);
const MUX_EXECUTABLES = new Set(["tmux", "tmux.exe", "psmux", "psmux.exe", "pmux", "pmux.exe"]);
const SAFE_MUX_COMMANDS = new Set([
	"dump-state",
	"has-session",
	"info",
	"list-buffers",
	"list-clients",
	"list-commands",
	"list-keys",
	"list-panes",
	"list-sessions",
	"list-windows",
	"server-info",
	"show-buffer",
	"show-environment",
	"show-hooks",
	"show-messages",
	"show-options",
	"show-window-options",
]);
const MUX_COMMAND_ALIASES: Record<string, string> = {
	capturep: "capture-pane",
	display: "display-message",
	dump: "dump-state",
	has: "has-session",
	ls: "list-sessions",
	lsb: "list-buffers",
	lsc: "list-clients",
	lscm: "list-commands",
	lsk: "list-keys",
	lsp: "list-panes",
	lsw: "list-windows",
	show: "show-options",
	showb: "show-buffer",
	showenv: "show-environment",
	showmsgs: "show-messages",
	showw: "show-window-options",
};
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

function isSafeFind(args: string[]): boolean {
	return !args.some((arg) => FIND_WRITE_ACTIONS.has(arg));
}

function commandBaseName(command: string): string {
	return command.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function isMuxExecutable(command: string): boolean {
	return MUX_EXECUTABLES.has(commandBaseName(command));
}

function hasUnsafeMuxArgument(args: string[]): boolean {
	return args.some((arg) => arg.includes("#(") || arg.includes(";"));
}

function parseMuxGlobalArgs(args: string[]): string[] | undefined {
	let index = 0;

	while (index < args.length) {
		const arg = args[index];
		if (arg === "-L" || arg === "-S" || arg === "-t") {
			if (index + 1 >= args.length) return undefined;
			index += 2;
			continue;
		}
		if ((arg.startsWith("-L") || arg.startsWith("-S") || arg.startsWith("-t")) && arg.length > 2) {
			index++;
			continue;
		}
		break;
	}

	return args.slice(index);
}

function parseMuxShortArgs(
	args: string[],
	booleanFlags: string,
	valueFlags: Set<string>,
): { flags: Set<string>; positionals: string[] } | undefined {
	const flags = new Set<string>();
	const positionals: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") {
			positionals.push(...args.slice(index + 1));
			break;
		}
		if (!/^-[^-]/.test(arg)) {
			positionals.push(arg);
			continue;
		}

		const cluster = arg.slice(1);
		for (let flagIndex = 0; flagIndex < cluster.length; flagIndex++) {
			const flag = cluster[flagIndex];
			if (valueFlags.has(`-${flag}`)) {
				flags.add(flag);
				if (flagIndex === cluster.length - 1) {
					if (index + 1 >= args.length) return undefined;
					index++;
				}
				break;
			}
			if (!booleanFlags.includes(flag)) return undefined;
			flags.add(flag);
		}
	}

	return { flags, positionals };
}

function isSafeMuxCapturePane(args: string[]): boolean {
	const parsed = parseMuxShortArgs(args, "aCeFHJLMNpPqT", new Set(["-b", "-E", "-S", "-t"]));
	return !!parsed && parsed.flags.has("p") && parsed.positionals.length === 0;
}

function isSafeMuxDisplayMessage(args: string[]): boolean {
	const parsed = parseMuxShortArgs(args, "alpv", new Set(["-F", "-t"]));
	return !!parsed && parsed.flags.has("p") && parsed.positionals.length <= 1;
}

function isSafeMux(args: string[]): boolean {
	if (hasUnsafeMuxArgument(args)) return false;

	const commandArgs = parseMuxGlobalArgs(args);
	if (!commandArgs || commandArgs.length === 0) return false;
	if (commandArgs.length === 1 && (commandArgs[0] === "-V" || commandArgs[0] === "--version")) return true;

	const [rawSubcommand, ...subcommandArgs] = commandArgs;
	const subcommand = MUX_COMMAND_ALIASES[rawSubcommand] ?? rawSubcommand;
	if (SAFE_MUX_COMMANDS.has(subcommand)) return true;
	if (subcommand === "capture-pane") return isSafeMuxCapturePane(subcommandArgs);
	if (subcommand === "display-message") return isSafeMuxDisplayMessage(subcommandArgs);
	return false;
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

/**
 * Drops leading shell keywords. Loop / case headers (`for x in ...`, `case x in`) execute
 * nothing themselves and yield an empty argv.
 */
function stripShellKeywords(argv: string[]): string[] {
	let index = 0;
	while (index < argv.length && SHELL_KEYWORDS.has(argv[index])) {
		if (argv[index] === "for" || argv[index] === "case") return [];
		index++;
	}
	return argv.slice(index);
}

/** For `env A=b cmd`, `xargs -n1 cmd`, `nohup cmd` etc., returns the wrapped argv (or undefined). */
function unwrapCommand(argv: string[]): string[] | undefined {
	const name = commandBaseName(argv[0]);
	if (!WRAPPER_COMMANDS.has(name)) return undefined;
	let index = 1;
	while (index < argv.length) {
		const arg = argv[index];
		const isFlag = arg.startsWith("-");
		const isAssignment = name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg);
		const isFlagValue = name === "xargs" && (/^\d+$/.test(arg) || arg === "{}");
		if (!isFlag && !isAssignment && !isFlagValue) break;
		index++;
	}
	return argv.slice(index);
}

function isDestructiveGit(args: string[]): boolean {
	const options: string[] = [];
	let subcommand: string | undefined;
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (subcommand === undefined && arg.startsWith("-")) {
			skipNext = GIT_GLOBAL_VALUE_OPTIONS.has(arg);
			continue;
		}
		if (subcommand === undefined) {
			subcommand = arg;
			continue;
		}
		options.push(arg);
	}
	if (!subcommand) return false;
	if (GIT_WRITE_SUBCOMMANDS.has(subcommand)) return true;
	if (subcommand === "branch") return options.some((arg) => GIT_BRANCH_UNSAFE_FLAGS.has(arg));
	if (subcommand === "remote") return options.length > 0 && GIT_REMOTE_WRITE_SUBCOMMANDS.has(options[0]);
	if (subcommand === "config") return !options.some((arg) => GIT_CONFIG_READ_FLAGS.has(arg));
	return false;
}

function hasInPlaceFlag(args: string[]): boolean {
	return args.some((arg) => arg === "-i" || /^-[^-]*i/.test(arg) || arg.startsWith("--in-place"));
}

function inlineScriptWrites(args: string[], flags: Set<string>, pattern: RegExp): boolean {
	for (let index = 0; index < args.length; index++) {
		if (flags.has(args[index]) && args[index + 1] !== undefined && pattern.test(args[index + 1])) return true;
	}
	return false;
}

function isDestructiveSegment(segment: Segment): boolean {
	const writesOutsideTmp = segment.redirections.some((redirection) =>
		redirection.kind === "file" && redirection.operator !== "<" && !isSafeOutputTarget(redirection.target),
	);
	if (writesOutsideTmp) return true;

	let argv = stripShellKeywords(segment.argv);
	if (argv.length === 0) return false;

	const wrapped = unwrapCommand(argv);
	if (wrapped !== undefined) {
		if (wrapped.length === 0) return false;
		argv = wrapped;
	}

	const [command, ...args] = argv;
	const name = commandBaseName(command);

	if (DESTRUCTIVE_COMMANDS.has(name)) return true;
	if (name === "npx") return true;
	if (name === "git") return isDestructiveGit(args);
	if (name in PACKAGE_WRITE_SUBCOMMANDS) return args.length > 0 && PACKAGE_WRITE_SUBCOMMANDS[name].has(args[0]);
	if (name === "service") return args.length >= 2 && SERVICE_WRITE_ACTIONS.has(args[1]);
	if (name === "sed") return hasInPlaceFlag(args);
	if (name === "perl") {
		return hasInPlaceFlag(args)
			|| args.some((arg) => /^-[^-]*p/.test(arg))
			|| inlineScriptWrites(args, new Set(["-e", "-E"]), PERL_INLINE_WRITE_RE);
	}
	if (name === "find") return args.some((arg) => FIND_WRITE_ACTIONS.has(arg));
	if (name === "curl") return !isSafeCurl(args);
	if (name === "wget") return !isSafeWget(args);
	if (name === "node") return inlineScriptWrites(args, new Set(["-e", "--eval", "-p", "--print"]), NODE_INLINE_WRITE_RE);
	if (/^python[23]?$/.test(name)) return inlineScriptWrites(args, new Set(["-c"]), PYTHON_INLINE_WRITE_RE);
	if (name === "ruby") return inlineScriptWrites(args, new Set(["-e"]), RUBY_INLINE_WRITE_RE);
	return false;
}

function isSafeSegment(segment: Segment): boolean {
	let argv = stripShellKeywords(segment.argv);
	if (argv.length === 0) return true;

	// `env A=b cmd`, `xargs cmd`: the wrapped command decides. A bare `env A=b` prints the environment.
	const wrapped = unwrapCommand(argv);
	if (wrapped !== undefined) {
		if (wrapped.length === 0) return commandBaseName(argv[0]) !== "env" || isSafeEnv(argv.slice(1));
		argv = wrapped;
	}

	const [command, ...args] = argv;
	const commandName = commandBaseName(command);

	const readsOnly = SIMPLE_SAFE_COMMANDS.has(commandName)
		|| (isMuxExecutable(command) && isSafeMux(args))
		|| (commandName === "git" && isSafeGit(args))
		|| (commandName === "npm" && isSafeNpm(args))
		|| (commandName === "yarn" && isSafeYarn(args))
		|| (commandName === "find" && isSafeFind(args))
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

export function isMuxCommand(command: string): boolean {
	const segments = parseSegments(command);
	if (segments?.some((segment) => segment.argv.some(isMuxExecutable))) return true;
	return /\b(?:tmux|psmux|pmux)(?:\.exe)?\b/i.test(command);
}

/**
 * Per-segment classification on the command word. Commands the tokenizer cannot parse
 * (heredocs, `$(...)`, backticks, `&`) are treated as destructive so they prompt.
 */
export function isDestructiveCommand(command: string): boolean {
	if (containsUnsafeExpansion(command)) return true;
	const segments = parseSegments(command);
	if (!segments) return true;
	return segments.some((segment) => isDestructiveSegment(segment));
}
