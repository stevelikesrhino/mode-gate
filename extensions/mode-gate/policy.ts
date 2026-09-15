/** A permission heuristic over tool requests; shell programs and trusted extensions are not sandboxed. */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { iterateCommands, literalText, parseCommand, plainText, type SimpleCommand } from "./parse.js";

export type Effect = "write" | "execute" | "destructive" | "unknown";
export interface Finding { effect: Effect; reason: string; path?: string; routine?: boolean; category?: string }
export interface Analysis { findings: Finding[]; command?: string; cwd: string }
export interface Scope { path: string; directory: boolean }

/** Placeholder for an argument whose value is only known at run time (variable, glob, substitution). */
const EXPANDED = "\u0000expanded";

export function inside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Resolve missing targets through their existing ancestors, including symlinks. */
export function canonicalPath(path: string): string {
	try { return realpathSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// A dangling symlink is not a new ordinary file.
		try {
			if (lstatSync(path).isSymbolicLink()) throw new Error(`Dangling symlink: ${path}`);
		} catch (statError) {
			if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
		}
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(canonicalPath(parent), basename(path));
	}
}

/** Matches installed pi edit/write normalization. Bash paths use shellPath instead. */
export function toolPath(input: string, cwd: string): string {
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	else if (path.startsWith("file://")) path = fileURLToPath(path);
	return canonicalPath(resolve(cwd, path));
}

function shellPath(input: string, cwd: string | undefined): string | undefined {
	if (input === EXPANDED) return undefined;
	// Tilde expansion belongs to the parser: a quoted ~ is an ordinary filename.
	if (!isAbsolute(input) && cwd === undefined) return undefined;
	// Unlike pi tool paths, kernel shell paths traverse symlinks before a following '..'.
	let current = isAbsolute(input) ? "/" : cwd!;
	for (const part of input.split("/")) {
		if (!part || part === ".") continue;
		current = part === ".." ? dirname(current) : canonicalPath(join(current, part));
	}
	return current;
}

function identity(path: string): string | undefined {
	try {
		const stat = statSync(path, { bigint: true });
		return stat.isFile() && stat.nlink === 1n ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

export function exists(path: string): boolean {
	try { lstatSync(path); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return false;
	}
}

/** Directory grants exclude nested repository/agent control directories. Execution grants cover a program category in a cwd. */
export class Permissions {
	readonly scopes: Scope[] = [];
	readonly categories = new Set<string>();
	private readonly createdFiles = new Map<string, string>();
	clear(): void { this.scopes.length = 0; this.categories.clear(); this.createdFiles.clear(); }
	grant(path: string, directory: boolean): void {
		if (!this.scopes.some((s) => s.path === path && s.directory === directory)) this.scopes.push({ path, directory });
	}
	rememberCreated(path: string): void {
		const id = identity(path);
		if (id) this.createdFiles.set(path, id);
	}
	isCreated(path: string): boolean { return this.createdFiles.has(path) && this.createdFiles.get(path) === identity(path); }
	canWrite(path: string): boolean {
		// Hard links can modify another path outside the approved scope.
		if (exists(path) && identity(path) === undefined) return false;
		if (this.isCreated(path)) return true;
		return this.scopes.some((s) => s.directory
			? inside(path, s.path) && !relative(s.path, path).split(sep).some((part) => [".git", ".pi", ".codex", ".agents"].includes(part))
			: s.path === path);
	}
	categoryKey(cwd: string, category: string): string { return JSON.stringify([cwd, category]); }
	needsApproval(analysis: Analysis): boolean {
		return analysis.findings.some((f) => f.effect === "write"
			? !f.routine && (!f.path || !this.canWrite(f.path))
			: f.effect !== "execute" || !f.category || !this.categories.has(this.categoryKey(analysis.cwd, f.category)));
	}
}

export function analyzeFile(path: string, cwd: string): Analysis {
	return { cwd, findings: [{ effect: "write", path, reason: exists(path) ? "Change existing file" : "Create file" }] };
}

const READ_COMMANDS = new Set("cat head tail ls pwd wc stat du df uname whoami id cal uptime ps lsof free basename dirname realpath readlink tr cut paste column tac rev nproc strings shasum sha256sum md5sum md5 od hexdump xxd nl test [ true false : diff cmp printenv which whereis type uniq jq tree file less more bat seq expr sleep continue break".split(" "));
const DESTRUCTIVE = new Set("rm rmdir mv truncate dd shred install patch ln chmod chown chgrp chflags sudo doas su kill pkill killall reboot shutdown mkfs diskutil scp sftp rsync ssh osascript launchctl systemctl service crontab defaults pmset networksetup terraform kubectl helm aws gcloud az mysql psql sqlite3 mongosh mongo redis-cli kcat kafka-console-producer docker podman brew apt apt-get dnf pacman".split(" "));
const EXECUTABLES = new Set("npm pnpm yarn bun npx make cmake mvn mvnw gradle gradlew cargo go javac java tsc pytest vitest jest node python python3 python2 ruby perl php deno swift dotnet pip pip3".split(" "));
const TRUSTED_BIN = ["/bin", "/usr/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/usr/local/sbin", "/opt/homebrew/bin", "/opt/homebrew/sbin"];

/** Wrappers that run their trailing argv unchanged. valueFlags consume the following argument. */
const WRAPPERS: Record<string, { valueFlags: string[]; positional?: RegExp }> = {
	nice: { valueFlags: ["-n", "--adjustment"] },
	timeout: { valueFlags: ["-s", "--signal", "-k", "--kill-after"], positional: /^\d+(?:\.\d+)?[smhd]?$/ },
	nohup: { valueFlags: [] },
	caffeinate: { valueFlags: ["-t", "-w"] },
	stdbuf: { valueFlags: ["-i", "-o", "-e", "--input", "--output", "--error"] },
};

function assignmentRisk(name: string): boolean {
	return /^(?:PATH|HOME|XDG_.*|CURL_HOME|RIPGREP_CONFIG_PATH|CDPATH|IFS|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|GLOBIGNORE|LD_.*|DYLD_.*|GIT_.*|NODE_OPTIONS|PYTHON.*|PERL.*|RUBY.*|HUSKY.*|LEFTHOOK.*|PRE_COMMIT.*|SKIP|SKIP_.*|npm_config_.*|NPM_CONFIG_.*|PNPM_.*|YARN_.*|MAVEN_.*|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|CARGO_.*|RUSTFLAGS|GOFLAGS|GOPATH|GOROOT|PIP_.*)$/.test(name);
}

function wordValue(word: SimpleCommand["words"][number]): string | undefined {
	const value = literalText(word);
	if (value === undefined) return undefined;
	if (word.parts[0]?.kind === "tilde") {
		if (word.parts[0].user) return undefined;
		return homedir() + value.slice(1);
	}
	return value;
}

/** Numeric Python calculations only; general inline code has opaque effects. */
function numericPython(source: string): boolean {
	return /^\s*print\(\s*[\d\s()+*/%.,eE-]+\s*\)\s*$/.test(source);
}

/** sed scripts made only of prints, deletes, quits and substitutions never write or execute. */
const SED_RANGE = String.raw`(?:\d+|\$|/(?:\\.|[^/\\])*/)`;
const SED_COMMAND = new RegExp(String.raw`^\s*(?:${SED_RANGE}(?:,${SED_RANGE})?)?!?\s*(?:[pdq=lnN]|s([^\\\n])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpIiMm0-9]*)\s*(?:;|\n|$)`);
function safeSedScript(script: string): boolean {
	let rest = script;
	while (rest.trim()) {
		const match = SED_COMMAND.exec(rest);
		if (!match) return false;
		rest = rest.slice(match[0].length);
	}
	return true;
}

/** Read-only subcommand forms of programs that are otherwise system, remote or database operations. */
function readOnlyForm(name: string, args: string[]): boolean {
	const [sub, next] = args;
	if (sub === undefined || sub === EXPANDED || next === EXPANDED) return false;
	const subIn = (list: string) => list.split(" ").includes(sub);
	const nextIn = (list: string) => next !== undefined && list.split(" ").includes(next);
	switch (name) {
		case "brew": return subIn("list ls info config doctor deps uses outdated search leaves --version -v --prefix --cellar --repository --cache") || sub === "services" && next === "list";
		case "docker": case "podman":
			return subIn("ps images inspect logs version info stats top port diff history events")
				|| subIn("image container network volume compose context system node service") && nextIn("ls list inspect ps logs config version df events top stats history");
		case "kubectl": return subIn("get describe logs version cluster-info api-resources api-versions explain top diff") || sub === "config" && nextIn("view current-context get-contexts get-clusters get-users");
		case "helm": return subIn("list ls status get show search version history env");
		case "aws": return sub === "--version" || sub !== "s3api" && /^(?:describe|list|get|ls|head)(?:-|$)/.test(next ?? "");
		case "gcloud": return args.every((a) => a !== EXPANDED) && args.some((a) => ["list", "describe", "info", "version", "get-value"].includes(a));
		case "az": return args.every((a) => a !== EXPANDED) && (sub === "version" || args.includes("list") || args.includes("show"));
		case "systemctl": return subIn("status list-units list-unit-files is-active is-enabled is-failed show cat list-timers list-sockets list-dependencies --version");
		case "launchctl": return subIn("list print print-cache print-disabled blame hostinfo version");
		case "defaults": return subIn("read read-type domains find");
		case "pmset": return sub === "-g";
		case "crontab": return sub === "-l";
		case "apt": case "apt-get": return subIn("list search show policy depends rdepends showsrc changelog");
		case "dnf": return subIn("list search info repolist provides check-update");
		case "pacman": return /^-Q/.test(sub) || ["-Ss", "-Si", "-Sl"].includes(sub);
		default: return false;
	}
}

export function analyzeCommand(command: string, cwd: string): Analysis {
	const result: Analysis = { command, cwd: canonicalPath(cwd), findings: [] };
	const add = (effect: Effect, reason: string, path?: string, routine = false, category?: string) => {
		if (!result.findings.some((f) => f.effect === effect && f.reason === reason && f.path === path)) result.findings.push({ effect, reason, path, routine, category });
	};
	const parsed = parseCommand(command);
	if (!parsed.ok) {
		add("unknown", `Shell syntax requires review: ${parsed.error}`);
		return result;
	}
	const commands = [...iterateCommands(parsed.list)];
	// No speculative cwd simulation across failures, branches, subshells or functions.
	const changesCwd = commands.some((c) => c.type === "simple" && c.words.some((w) => ["cd", "pushd", "popd"].includes(plainText(w))));
	const pathCwd = changesCwd ? undefined : result.cwd;
	const write = (target: string | undefined, reason: string) => {
		if (target === "/dev/null") return;
		if (target?.startsWith("/dev/tcp/") || target?.startsWith("/dev/udp/")) { add("unknown", "Shell network redirection"); return; }
		const path = target === undefined || target === EXPANDED ? undefined : shellPath(target, pathCwd);
		add("write", path ? reason : `${reason}: target cannot be resolved statically`, path);
	};
	/** Skips leading options; flags in valueFlags consume the next argument. Returns the index of the first operand. */
	const skipOptions = (args: string[], valueFlags: string[]): number => {
		let i = 0;
		while (i < args.length && args[i] !== EXPANDED && args[i].startsWith("-") && args[i] !== "--") {
			if (valueFlags.includes(args[i])) i++;
			i++;
		}
		if (args[i] === "--") i++;
		return i;
	};

	function classify(argv: string[], simple: SimpleCommand, depth = 0): void {
		if (depth > 8) { add("unknown", "Too many command wrappers"); return; }
		if (!argv.length) return;
		const [executable, ...args] = argv;
		if (executable === EXPANDED) { add("unknown", "Executable is dynamically computed"); return; }
		const name = basename(executable);
		// A local program named cat/git/etc. is not the system utility.
		if (executable.includes("/") && !TRUSTED_BIN.includes(dirname(executable))) {
			add("execute", `Run program: ${executable}`, undefined, false, executable); return;
		}
		if (["command", "builtin"].includes(name)) {
			if (args[0] === "-v" || args[0] === "-V") return;
			if (args[0] !== EXPANDED && args[0]?.startsWith("-") && args[0] !== "--") { add("unknown", `${name} options require review`); return; }
			classify(args[0] === "--" ? args.slice(1) : args, simple, depth + 1); return;
		}
		if (name === "env") {
			let i = 0;
			while (i < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i])) {
				if (assignmentRisk(args[i].split("=")[0])) add("unknown", "Environment changes program behavior");
				i++;
			}
			if (args[i] !== EXPANDED && args[i]?.startsWith("-")) { add("unknown", "env options require review"); return; }
			classify(args.slice(i), simple, depth + 1); return;
		}
		if (name in WRAPPERS) {
			const spec = WRAPPERS[name];
			let i = skipOptions(args, spec.valueFlags);
			if (name === "nice" && /^-\d+$/.test(args[0] ?? "")) i = Math.max(i, 1);
			if (spec.positional) {
				if (!spec.positional.test(args[i] ?? "")) { add("unknown", `${name} argument is not a literal duration`); return; }
				i++;
			}
			classify(args.slice(i), simple, depth + 1); return;
		}
		if (name === "xargs") {
			let replace: string | undefined;
			let i = 0;
			while (i < args.length && args[i] !== EXPANDED && args[i].startsWith("-") && args[i] !== "--") {
				const flag = args[i++];
				if (flag === "-I" || flag === "-J" || flag === "--replace") replace = args[i++];
				else if (/^-[IJ]./.test(flag)) replace = flag.slice(2);
				else if (flag.startsWith("--replace=")) replace = flag.slice(10);
				else if (["-n", "-P", "-d", "-L", "-s", "-a", "-E", "-R", "-S", "--max-args", "--max-procs", "--delimiter", "--max-lines", "--max-chars", "--arg-file", "--eof"].includes(flag)) i++;
			}
			if (args[i] === "--") i++;
			const target = args.slice(i);
			if (!target.length) return;
			const rest = target.map((a) => replace !== undefined && a.includes(replace) ? EXPANDED : a);
			if (replace === undefined) rest.push(EXPANDED);
			classify(rest, simple, depth + 1); return;
		}
		if (["bash", "sh", "zsh", "dash"].includes(name)) {
			if (args.length === 2 && args[0] === "-c") {
				if (args[1] === EXPANDED) { add("unknown", "Shell command string is dynamic"); return; }
				const nested = analyzeCommand(args[1], result.cwd);
				for (const f of nested.findings) add(f.effect, f.reason, f.path, f.routine, f.category);
			} else add("unknown", "Shell script or shell options require review");
			return;
		}
		if (DESTRUCTIVE.has(name)) {
			if (readOnlyForm(name, args)) return;
			add("destructive", `${name}: deletion, system, database or remote operation`); return;
		}
		if (["eval", "exec", "source", ".", "export", "declare", "typeset", "local", "set", "shopt", "trap", "alias", "unalias"].includes(name)) {
			add("unknown", `${name}: execution or shell state requires review`); return;
		}
		if (name === "read") {
			const names: string[] = [];
			let i = 0;
			while (i < args.length && args[i] !== EXPANDED && args[i].startsWith("-") && args[i] !== "--") {
				const flag = args[i++];
				if (["-a", "-d", "-i", "-n", "-N", "-p", "-t", "-u"].includes(flag)) { if (flag === "-a") names.push(args[i] ?? ""); i++; }
			}
			if (args[i] === "--") i++;
			names.push(...args.slice(i));
			if (names.some((n) => n === EXPANDED || assignmentRisk(n))) add("unknown", "read into an environment-sensitive variable requires review");
			return;
		}
		if (name === "cd") return;
		if (READ_COMMANDS.has(name)) return;
		if (name === "echo") return;
		if (name === "printf") {
			const format = args[0] === "--" ? args[1] : args[0];
			if (format === EXPANDED) { add("unknown", "printf format is dynamic"); return; }
			if (args[0]?.startsWith("-v") || args.some((arg) => /%[-+ #0]*\d*(?:\.\d+)?n/.test(arg))) add("unknown", "printf variable assignment requires review");
			return;
		}
		if (name === "date") {
			if (args.every((a) => a.startsWith("+") || ["-u", "--utc", "--iso-8601", "-I", "-R"].includes(a))) return;
			add("unknown", "date options may set the clock"); return;
		}
		if (name === "rg") {
			if (args.some((a) => /^(?:--pre(?:=|$)|--hostname-bin(?:=|$))/.test(a))) add("unknown", "rg can execute another program");
			return;
		}
		if (name === "grep") return;
		if (["awk", "gawk", "mawk", "nawk"].includes(name)) {
			let program: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a === "--") { if (program === undefined) program = args[i + 1]; break; }
				if (a === EXPANDED && program === undefined) { add("unknown", "awk program or options are dynamic"); return; }
				// Only -F and -v take inert values; other options may load code or write files.
				if (a === "-F" || a === "-v") { i++; continue; }
				if (/^-[Fv]./.test(a)) continue;
				if (a.startsWith("-") && a !== "-") { add("unknown", `awk option requires review: ${a}`); return; }
				if (program === undefined) program = a;
			}
			if (program === EXPANDED) { add("unknown", "awk program is dynamic"); return; }
			if (/system\s*\(|\b(?:print|printf)\b[^;}\n]*(?:>|\|)|\|\s*getline\b/.test(program ?? "")) add("unknown", "awk program can execute or write");
			return;
		}
		if (name === "fd") {
			if (args.some((a) => /^(?:-x|-X|--exec|--exec-batch)(?:=|$)/.test(a))) add("unknown", "fd can execute another program");
			return;
		}
		if (name === "find") {
			const valuePrimary = /^-(?:i?name|i?path|i?wholename|i?regex|i?lname|type|size|maxdepth|mindepth|mtime|mmin|atime|amin|ctime|cmin|newer|newermt|user|group|perm|links|inum|samefile|regextype)$/;
			let inExpression = false;
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a === EXPANDED) {
					if (inExpression && !valuePrimary.test(args[i - 1] ?? "")) { add("unknown", "find expression is dynamic"); return; }
					continue;
				}
				if (a.startsWith("-") || a === "(" || a === "!") inExpression = true;
				if (a === "-exec" || a === "-execdir") {
					const end = args.findIndex((x, j) => j > i && (x === ";" || x === "+"));
					if (end < 0) { add("unknown", "find -exec is not terminated"); return; }
					classify(args.slice(i + 1, end).map((x) => (x === "{}" ? EXPANDED : x)), simple, depth + 1);
					i = end;
					continue;
				}
				if (a === "-delete") { add("destructive", "find -delete removes files"); return; }
				if (/^-(?:ok|okdir)$/.test(a)) { add("unknown", "find interactive action requires review"); return; }
				if (/^-(?:fprint|fprint0|fprintf|fls)$/.test(a)) { write(args[++i], "find output"); continue; }
			}
			return;
		}
		if (name === "sed") {
			const scripts: string[] = [];
			const operands: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a === "--") { operands.push(...args.slice(i + 1)); break; }
				if (a === "-e" || a === "--expression") { scripts.push(args[++i] ?? EXPANDED); continue; }
				if (a.startsWith("--expression=")) { scripts.push(a.slice(13)); continue; }
				if (a === EXPANDED) { operands.push(a); continue; }
				if (/^-[nrE]+$/.test(a) || ["--quiet", "--silent", "--regexp-extended", "--posix"].includes(a)) continue;
				if (a.startsWith("-")) { add("unknown", `sed option requires review: ${a}`); return; }
				operands.push(a);
			}
			if (!scripts.length && operands.length) scripts.push(operands.shift()!);
			if (scripts.length && scripts.every((s) => s !== EXPANDED && safeSedScript(s))) return;
			add("unknown", "sed program can execute or write; review the expression"); return;
		}
		if (name === "sort") {
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a === "-o" || a === "--output") write(args[++i], "sort output");
				else if (a.startsWith("--output=")) write(a.slice(9), "sort output");
				else if (/^-[^-].*o/.test(a) || /^--(?:out|compress)/.test(a)) add("unknown", "sort output/execution option requires review");
			}
			return;
		}
		if (name === "mkdir") {
			if (args.some((a) => a !== EXPANDED && a.startsWith("-") && !["-p", "--parents", "--"].includes(a))) { add("unknown", "mkdir options require review"); return; }
			for (const a of args.filter((a) => a !== "--" && a !== "-p" && a !== "--parents")) {
				const path = shellPath(a, pathCwd);
				// Creating a project directory is bounded and reversible. No ownership of its contents is inferred.
				if (!path || !inside(path, result.cwd) || exists(path)) {
					if (!(path && args.some((a) => a === "-p" || a === "--parents") && statSync(path, { throwIfNoEntry: false })?.isDirectory())) write(a, "Create directory");
			} else add("write", "Create project directory", path, true);
			}
			return;
		}
		if (["touch", "tee"].includes(name)) {
			if (args.some((a) => a !== EXPANDED && a.startsWith("-") && !(name === "tee" && ["-a", "--append"].includes(a)) && a !== "--")) { add("unknown", `${name} options require review`); return; }
			for (const a of args.filter((a) => a === EXPANDED || !a.startsWith("-"))) write(a, `${name} target`);
			return;
		}
		if (name === "cp") {
			if (args.length !== 2 || args.some((a) => a !== EXPANDED && a.startsWith("-"))) { add("unknown", "cp options or multiple targets require review"); return; }
			const destination = shellPath(args[1], pathCwd);
			write(destination && statSync(destination, { throwIfNoEntry: false })?.isDirectory() ? join(destination, basename(args[0])) : args[1], "Copy file"); return;
		}
		if (name === "git") {
			let rest = args;
			while (rest[0] === "-C" && rest[1]) rest = rest.slice(2);
			if (rest[0] === EXPANDED) { add("unknown", "Git subcommand is dynamic"); return; }
			if (rest[0]?.startsWith("-")) { add("unknown", "Git global options can change execution"); return; }
			const [sub, ...options] = rest;
			if (options.some((a) => /^--(?:out|ext|textconv|exec)/.test(a))) { add("unknown", "Git output or external helper requires review"); return; }
			if (["status", "diff", "log", "show", "blame", "ls-files", "ls-tree", "rev-parse", "rev-list", "describe", "shortlog", "grep", "cat-file", "name-rev", "merge-base", "count-objects", "var"].includes(sub)) return;
			if (sub === "branch" && options.every((a) => ["--show-current", "--list", "-a", "-r", "-v", "-vv", "--all", "--remotes", "--merged", "--no-merged", "--contains"].includes(a))) return;
			if (sub === "remote" && (options.length === 0 || options.length === 1 && options[0] === "-v" || ["show", "get-url"].includes(options[0]))) return;
			if (sub === "config" && (options[0] === "--list" || options[0] === "-l" || /^--get/.test(options[0] ?? ""))) return;
			if (["stash", "tag", "worktree"].includes(sub) && (options[0] === "list" || sub !== "stash" && options.length === 0 || sub === "tag" && options.every((a) => a === "-l" || a === "--list" || !a.startsWith("-")) && options.includes("-l"))) return;
			if (["push", "reset", "restore", "clean", "checkout", "rebase", "filter-branch", "update-ref", "reflog", "gc", "prune", "remote", "config", "branch", "tag", "stash", "rm", "mv", "worktree"].includes(sub) || options.includes("--amend")) add("destructive", `Git ${sub}: history, worktree or shared state change`);
			else add("execute", `Git ${sub ?? "command"}: local repository operation`, undefined, false, "git");
			return;
		}
		if (name === "curl") {
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a === EXPANDED || /^https?:\/\//.test(a)) continue;
				if (["-o", "--output"].includes(a)) { const target = args[++i]; if (/#\d/.test(target ?? "")) add("unknown", "curl output template has dynamic targets"); else write(target, "Download output"); continue; }
				if (a.startsWith("--output=")) { const target = a.slice(9); if (/#\d/.test(target)) add("unknown", "curl output template has dynamic targets"); else write(target, "Download output"); continue; }
				if (["-X", "--request"].includes(a)) {
					if (!["GET", "HEAD"].includes(args[++i])) add("destructive", "HTTP request can mutate a remote service");
					continue;
				}
				if (/^--request=/.test(a)) { if (!["GET", "HEAD"].includes(a.slice(10))) add("destructive", "HTTP request can mutate a remote service"); continue; }
				if (["--connect-timeout", "--max-time", "--retry", "-m", "-A", "--user-agent"].includes(a)) { i++; continue; }
				if (["--silent", "--show-error", "--fail", "--location", "--head", "--insecure", "--disable"].includes(a) || /^-[sSfLIkq]+$/.test(a)) continue;
				add("unknown", `curl option requires review: ${a}`);
			}
			return;
		}
		if (name === "tmux") {
			let rest = args;
			while (["-S", "-L"].includes(rest[0]) && rest[1]) rest = rest.slice(2);
			const [sub, ...options] = rest;
			if (sub === EXPANDED) { add("unknown", "tmux command is dynamic"); return; }
			if (args.some((a) => a.includes(";") || a.includes("#("))) { add("unknown", "tmux command or format can execute code"); return; }
			if (["list-sessions", "ls", "list-panes", "list-windows", "has-session", "show-options", "-V"].includes(sub)) return;
			if (["capture-pane", "capturep", "display-message", "display"].includes(sub)) {
				let prints = false;
				let valid = true;
				for (let i = 0; i < options.length; i++) {
					if (["-t", "-S", "-E", "-F"].includes(options[i]) && options[i + 1] !== undefined) { i++; continue; }
					if (options[i] === "-p") prints = true;
					else if (!["-J", "-e", "-q"].includes(options[i])) valid = false;
				}
				if (prints && valid) return;
			}
			add("destructive", "tmux control can affect another session"); return;
		}
		if (/^python[23]?$/.test(name)) {
			if (args.length === 1 && args[0] === "--version") return;
			const source = args.length === 2 && args[0] === "-c" ? args[1]
				: args.length === 1 && args[0] === "-" && simple.redirects.length === 1 ? simple.redirects[0].heredoc?.body : undefined;
			if (source !== undefined && source !== EXPANDED && numericPython(source)) return;
			if (source !== undefined || args.some((a) => a.startsWith("-c") || a === "-")) { add("unknown", "Inline Python requires review"); return; }
		}
		if (["node", "ruby", "perl", "php", "deno", "bun"].includes(name) && args.some((a) => /^(?:-[^-]*[epi]|--eval|--print)/.test(a))) {
			add("unknown", `Inline ${name} requires review`); return;
		}
		if (EXECUTABLES.has(name)) {
			if (args[0] === EXPANDED) { add("unknown", `${name} subcommand is dynamic`); return; }
			if (args.some((a) => /^(?:publish|deploy|destroy|apply|push|--global|-g|--system)$/.test(a) || /(?:^|:)deploy$/.test(a))) add("destructive", `${name}: publish, deployment or global mutation`);
			else add("execute", `${name}: program or project scripts determine the effects`, undefined, false, name);
			return;
		}
		add("unknown", `Unclassified program: ${name}`);
	}

	for (const node of commands) {
		for (const r of node.redirects) {
			if (["<<", "<<<"].includes(r.op)) continue;
			const target = r.target && wordValue(r.target);
			if (r.op === "<") {
				// Reading from a file is harmless; a network device is the only input that matters.
				if (target === undefined ? /\/dev\//.test(r.target?.raw ?? "") : target.startsWith("/dev/tcp/") || target.startsWith("/dev/udp/")) add("unknown", "Network input redirection");
				continue;
			}
			if ([">&", "<&"].includes(r.op) && /^(?:\d+|-)$/ .test(target ?? "")) continue;
			write(target, `Shell ${r.op} output`);
		}
		if (node.type !== "simple") {
			if (node.type === "function") add("unknown", "Function definitions can replace command behavior");
			if (node.type === "for" && assignmentRisk(node.varName)) add("unknown", "Loop variable changes program behavior");
			continue;
		}
		// `IFS= read -r line` is the standard line-reading idiom; the assignment is scoped to the builtin.
		const readsLine = node.words.length > 0 && plainText(node.words[0]) === "read";
		for (const assignment of node.assignments) if (assignmentRisk(assignment.name) && !(readsLine && assignment.name === "IFS")) add("unknown", "Environment assignment changes program behavior");
		if (!node.words.length) continue;
		const values = node.words.map(wordValue);
		const name = values[0];
		if (name === undefined) { add("unknown", "Executable is dynamically computed"); continue; }
		classify(values.map((v) => v ?? EXPANDED), node);
	}
	if (changesCwd && result.findings.some((f) => f.effect === "write")) add("unknown", "Working directory changes make mutation scope uncertain");
	return result;
}
