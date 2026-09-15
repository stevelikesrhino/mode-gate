/**
 * Minimal bash parser for mode-gate.
 *
 * Produces an AST that preserves everything the policy needs: command words with
 * quoting/expansion info, assignments, redirections with heredoc bodies, pipelines,
 * lists, subshells, groups, loops, conditionals, functions, and nested command
 * substitutions. Anything it cannot understand is reported as a parse failure so the
 * gate can fail closed.
 */

export type WordPart =
	| { kind: "lit"; text: string; quoted: boolean }
	| { kind: "var"; name: string }
	| { kind: "cmd"; body: List; raw: string }
	| { kind: "arith"; raw: string }
	| { kind: "proc"; body: List; raw: string; dir: "<" | ">" }
	| { kind: "glob"; text: string }
	| { kind: "tilde"; user: string };

export interface Word {
	parts: WordPart[];
	raw: string;
}

export type RedirectOp = ">" | ">>" | "<" | ">&" | "<&" | "&>" | "&>>" | ">|" | "<<<" | "<>" | "<<";

export interface Redirect {
	fd?: number;
	op: RedirectOp;
	target?: Word;
	heredoc?: { body: string; quoted: boolean; delimiter: string };
}

export interface Assignment {
	name: string;
	value: Word;
	append: boolean;
}

export interface SimpleCommand {
	type: "simple";
	assignments: Assignment[];
	words: Word[];
	redirects: Redirect[];
}
export interface Subshell {
	type: "subshell";
	body: List;
	redirects: Redirect[];
}
export interface Group {
	type: "group";
	body: List;
	redirects: Redirect[];
}
export interface IfCommand {
	type: "if";
	clauses: { cond: List; body: List }[];
	elseBody?: List;
	redirects: Redirect[];
}
export interface ForCommand {
	type: "for";
	varName: string;
	words?: Word[];
	arith?: string;
	body: List;
	redirects: Redirect[];
}
export interface WhileCommand {
	type: "while";
	until: boolean;
	cond: List;
	body: List;
	redirects: Redirect[];
}
export interface CaseCommand {
	type: "case";
	word: Word;
	items: { patterns: Word[]; body: List }[];
	redirects: Redirect[];
}
export interface FunctionDef {
	type: "function";
	name: string;
	body: Command;
	redirects: Redirect[];
}
export interface ArithCommand {
	type: "arith";
	raw: string;
	redirects: Redirect[];
}
export interface CondCommand {
	type: "cond";
	raw: string;
	redirects: Redirect[];
}

export type Command =
	| SimpleCommand
	| Subshell
	| Group
	| IfCommand
	| ForCommand
	| WhileCommand
	| CaseCommand
	| FunctionDef
	| ArithCommand
	| CondCommand;

export interface Pipeline {
	commands: Command[];
	negated: boolean;
	timed: boolean;
	/** `|&` between commands (stderr piped too) */
	stderrPipes: boolean[];
}

export interface AndOr {
	pipelines: Pipeline[];
	ops: ("&&" | "||")[];
}

export interface ListItem {
	andor: AndOr;
	background: boolean;
}

export interface List {
	items: ListItem[];
}

export interface ParseResult {
	ok: boolean;
	list: List;
	error?: string;
}

type Token =
	| { type: "word"; word: Word; pos: number }
	| { type: "op"; op: string; pos: number }
	| { type: "redirect"; redirect: Redirect; pos: number }
	| { type: "newline"; pos: number }
	| { type: "eof"; pos: number };

const RESERVED = new Set([
	"if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "{", "}", "!", "time", "function", "select", "coproc",
]);
const OPERATOR_CHARS = new Set(["|", "&", ";", "(", ")", "<", ">", "\n"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPTH = 12;

class ParseError extends Error {}

/** Find the index of the closing delimiter for a `$(`, `` ` ``, `${`, `$((`, `<(` construct starting at `open`. */
function findClosing(src: string, open: number, openCh: string, closeCh: string): number {
	let depth = 0;
	let quote: "'" | '"' | undefined;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = undefined;
			else if (ch === "$" && src[i + 1] === "(") {
				const end = findClosing(src, i + 1, "(", ")");
				if (end < 0) return -1;
				i = end;
			} else if (ch === "`") {
				const end = findBacktick(src, i + 1);
				if (end < 0) return -1;
				i = end;
			}
			continue;
		}
		if (ch === "'") {
			quote = "'";
			continue;
		}
		if (ch === '"') {
			quote = '"';
			continue;
		}
		if (ch === "`" && openCh !== "`") {
			const end = findBacktick(src, i + 1);
			if (end < 0) return -1;
			i = end;
			continue;
		}
		if (ch === "#" && (i === open || /\s/.test(src[i - 1] ?? ""))) {
			// comment inside $( ... ) runs to end of line
			const nl = src.indexOf("\n", i);
			if (nl < 0) return -1;
			i = nl;
			continue;
		}
		if (ch === openCh) depth++;
		else if (ch === closeCh) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function findBacktick(src: string, from: number): number {
	for (let i = from; i < src.length; i++) {
		if (src[i] === "\\") {
			i++;
			continue;
		}
		if (src[i] === "`") return i;
	}
	return -1;
}

/** For `((` at `open`, returns the index just past the matching `))`, or -1. */
function findDoubleParenClose(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return src[i - 1] === ")" ? i + 1 : -1;
		} else if (ch === "'" || ch === '"') {
			const end = src.indexOf(ch, i + 1);
			if (end < 0) return -1;
			i = end;
		}
	}
	return -1;
}

const ANSI_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"' };

class Lexer {
	private pos: number;
	private pendingHeredocs: Redirect[] = [];
	private parenDepth = 0;
	/** Position just after the last consumed character (after the matching `)` in sub-lexer mode). */
	endPos = 0;
	readonly tokens: Token[] = [];

	constructor(
		private readonly src: string,
		private readonly depth: number,
		start = 0,
		/** Sub-lexer mode for `$( ... )` / `<( ... )`: stop after the unmatched closing paren. */
		private readonly stopAtCloseParen = false,
	) {
		this.pos = start;
	}

	lex(): Token[] {
		while (true) {
			const token = this.next();
			this.tokens.push(token);
			if (token.type === "eof") break;
		}
		return this.tokens;
	}

	private next(): Token {
		const src = this.src;
		// skip blanks and line continuations
		while (this.pos < src.length) {
			const ch = src[this.pos];
			if (ch === " " || ch === "\t") this.pos++;
			else if (ch === "\\" && src[this.pos + 1] === "\n") this.pos += 2;
			else if (ch === "\\" && src[this.pos + 1] === "\r" && src[this.pos + 2] === "\n") this.pos += 3;
			else if (ch === "\r") this.pos++;
			else break;
		}
		const start = this.pos;
		if (this.pos >= src.length) {
			if (this.pendingHeredocs.length) throw new ParseError("unterminated heredoc");
			if (this.stopAtCloseParen) throw new ParseError("unterminated $(");
			this.endPos = this.pos;
			return { type: "eof", pos: start };
		}
		const ch = src[this.pos];
		if (ch === "#") {
			const nl = src.indexOf("\n", this.pos);
			this.pos = nl < 0 ? src.length : nl;
			return this.next();
		}
		if (ch === "\n") {
			this.pos++;
			this.readHeredocBodies();
			return { type: "newline", pos: start };
		}
		// process substitution `<(cmd)` / `>(cmd)` is a word, not a redirection
		if ((ch === "<" || ch === ">") && src[this.pos + 1] === "(") return this.readWord(start);
		// redirection with numeric fd prefix: 2>, 2>&1, 10<
		const fdMatch = /^(\d+)([<>])/.exec(src.slice(this.pos, this.pos + 12));
		if (fdMatch) {
			this.pos += fdMatch[1].length;
			return this.readRedirect(Number(fdMatch[1]), start);
		}
		if (ch === "<" || ch === ">") return this.readRedirect(undefined, start);
		if (ch === "&" && src[this.pos + 1] === ">") return this.readRedirect(undefined, start);
		// arithmetic command `(( ... ))`
		if (ch === "(" && src[this.pos + 1] === "(") {
			throw new ParseError("arithmetic commands require review");
		}
		if (OPERATOR_CHARS.has(ch)) {
			const two = src.slice(this.pos, this.pos + 2);
			const three = src.slice(this.pos, this.pos + 3);
			if (three === ";;&") {
				this.pos += 3;
				return { type: "op", op: ";;&", pos: start };
			}
			if (two === "&&" || two === "||" || two === ";;" || two === "|&" || two === ";&") {
				this.pos += 2;
				return { type: "op", op: two, pos: start };
			}
			this.pos++;
			if (ch === "(") this.parenDepth++;
			if (ch === ")") {
				if (this.parenDepth === 0 && this.stopAtCloseParen) {
					if (this.pendingHeredocs.length) throw new ParseError("unterminated heredoc");
					this.endPos = this.pos;
					return { type: "eof", pos: start };
				}
				this.parenDepth--;
			}
			return { type: "op", op: ch, pos: start };
		}
		return this.readWord(start);
	}

	/** Lexes a nested `$( ... )` / `<( ... )` body starting after the opening paren; returns the parsed list and end position. */
	private subCommand(bodyStart: number): { body: List; end: number } {
		if (this.depth >= MAX_DEPTH) throw new ParseError("nesting too deep");
		const sub = new Lexer(this.src, this.depth + 1, bodyStart, true);
		const tokens = sub.lex();
		const body = new Parser(tokens, this.depth + 1).parseProgram();
		return { body, end: sub.endPos };
	}

	private readRedirect(fd: number | undefined, start: number): Token {
		const src = this.src;
		let op: RedirectOp;
		const rest = src.slice(this.pos, this.pos + 3);
		if (rest.startsWith("<<<")) {
			op = "<<<";
			this.pos += 3;
		} else if (rest.startsWith("<<-") || rest.startsWith("<<")) {
			const strip = rest.startsWith("<<-");
			this.pos += strip ? 3 : 2;
			// heredoc delimiter word
			this.skipBlanks();
			const delimWord = this.readWord(this.pos);
			if (delimWord.type !== "word") throw new ParseError("bad heredoc delimiter");
			if (delimWord.word.parts.some((p) => p.kind !== "lit")) throw new ParseError("unsupported heredoc delimiter");
			const quoted = delimWord.word.parts.some((p) => p.kind === "lit" && p.quoted);
			const delimiter = delimWord.word.parts.map((p) => (p.kind === "lit" ? p.text : "")).join("");
			const redirect: Redirect = { fd, op: "<<", heredoc: { body: "", quoted, delimiter } };
			(redirect as Redirect & { strip?: boolean }).strip = strip;
			this.pendingHeredocs.push(redirect);
			return { type: "redirect", redirect, pos: start };
		} else if (rest.startsWith("&>>")) {
			op = "&>>";
			this.pos += 3;
		} else if (rest.startsWith("&>")) {
			op = "&>";
			this.pos += 2;
		} else if (rest.startsWith(">>")) {
			op = ">>";
			this.pos += 2;
		} else if (rest.startsWith(">&")) {
			op = ">&";
			this.pos += 2;
		} else if (rest.startsWith("<&")) {
			op = "<&";
			this.pos += 2;
		} else if (rest.startsWith(">|")) {
			op = ">|";
			this.pos += 2;
		} else if (rest.startsWith("<>")) {
			op = "<>";
			this.pos += 2;
		} else if (rest.startsWith(">")) {
			op = ">";
			this.pos += 1;
		} else {
			op = "<";
			this.pos += 1;
		}
		this.skipBlanks();
		// `>&-`, `2>&1`, `>& file`
		const targetTok = this.readWord(this.pos, true);
		if (targetTok.type !== "word" || targetTok.word.parts.length === 0) throw new ParseError(`missing redirection target after ${op}`);
		return { type: "redirect", redirect: { fd, op, target: targetTok.word }, pos: start };
	}

	private skipBlanks(): void {
		while (this.pos < this.src.length && (this.src[this.pos] === " " || this.src[this.pos] === "\t")) this.pos++;
		while (this.src[this.pos] === "\\" && this.src[this.pos + 1] === "\n") {
			this.pos += 2;
			while (this.pos < this.src.length && (this.src[this.pos] === " " || this.src[this.pos] === "\t")) this.pos++;
		}
	}

	private readHeredocBodies(): void {
		if (!this.pendingHeredocs.length) return;
		const src = this.src;
		for (const redirect of this.pendingHeredocs) {
			const strip = (redirect as Redirect & { strip?: boolean }).strip === true;
			const delimiter = redirect.heredoc!.delimiter;
			const lines: string[] = [];
			let found = false;
			while (this.pos <= src.length) {
				let nl = src.indexOf("\n", this.pos);
				if (nl < 0) nl = src.length;
				let line = src.slice(this.pos, nl);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				this.pos = Math.min(nl + 1, src.length);
				const cmp = strip ? line.replace(/^\t+/, "") : line;
				if (cmp === delimiter) {
					found = true;
					break;
				}
				lines.push(strip ? line.replace(/^\t+/, "") : line);
				if (nl >= src.length) break;
			}
			if (!found) throw new ParseError(`unterminated heredoc (delimiter ${delimiter})`);
			redirect.heredoc!.body = lines.join("\n");
			if (!redirect.heredoc!.quoted && /[$`\\]/.test(redirect.heredoc!.body)) {
				throw new ParseError("expanding heredoc requires review; quote the delimiter for literal input");
			}
		}
		this.pendingHeredocs = [];
	}

	/** Reads one word starting at `from`. When `redirectTarget` is true, `&`-prefixed targets like `&1` / `&-` are accepted. */
	private readWord(from: number, redirectTarget = false): Token {
		const src = this.src;
		let i = from;
		const parts: WordPart[] = [];
		let lit = "";
		let litQuoted = false;
		const flush = () => {
			if (lit.length || litQuoted) {
				parts.push({ kind: "lit", text: lit, quoted: litQuoted });
			}
			lit = "";
			litQuoted = false;
		};
		const pushLit = (text: string, quoted: boolean) => {
			if (lit.length && litQuoted !== quoted) flush();
			lit += text;
			litQuoted = quoted || (litQuoted && lit.length > text.length);
			if (!lit.length) litQuoted = quoted;
		};

		if (redirectTarget && src[i] === "&") {
			// `>&1`, `>&-`: consume `&` plus the rest as literal
			i++;
			lit += "&";
		}

		// `[[ ... ]]` conditional and `(( ... ))` arithmetic are captured raw at word start
		if (src.startsWith("[[", i) && (i + 2 >= src.length || /\s/.test(src[i + 2]))) {
			throw new ParseError("extended shell condition requires review");
		}

		while (i < src.length) {
			const ch = src[i];
			if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
			if (OPERATOR_CHARS.has(ch)) {
				// `<(`, `>(` process substitution as part of a word
				if ((ch === "<" || ch === ">") && src[i + 1] === "(") {
					const { body, end } = this.subCommand(i + 2);
					flush();
					parts.push({ kind: "proc", body, raw: src.slice(i, end), dir: ch });
					i = end;
					continue;
				}
				// array assignment value: NAME=( a b "$(c)" )
				if (ch === "(" && parts.length === 0 && ASSIGNMENT_RE.test(lit) && lit.endsWith("=")) {
					throw new ParseError("array assignments require review");
				}
				break;
			}
			if (ch === "\\") {
				const nxt = src[i + 1];
				if (nxt === undefined) {
					pushLit("\\", true);
					i++;
					continue;
				}
				if (nxt === "\n") {
					i += 2;
					continue;
				}
				pushLit(nxt, true);
				i += 2;
				continue;
			}
			if (ch === "'") {
				const end = src.indexOf("'", i + 1);
				if (end < 0) throw new ParseError("unterminated single quote");
				pushLit(src.slice(i + 1, end), true);
				if (end === i + 1) litQuoted = true;
				i = end + 1;
				continue;
			}
			if (ch === "$" && src[i + 1] === "'") {
				// ANSI-C quoting
				let j = i + 2;
				let text = "";
				let closed = false;
				while (j < src.length) {
					const c = src[j];
					if (c === "\\") {
						const n = src[j + 1];
						if (!(n in ANSI_ESCAPES)) throw new ParseError("unsupported ANSI-C escape");
						text += ANSI_ESCAPES[n];
						j += 2;
						continue;
					}
					if (c === "'") {
						closed = true;
						break;
					}
					text += c;
					j++;
				}
				if (!closed) throw new ParseError("unterminated $'...'");
				pushLit(text, true);
				i = j + 1;
				continue;
			}
			if (ch === '"') {
				let j = i + 1;
				let closed = false;
				let quotedEmpty = true;
				while (j < src.length) {
					const c = src[j];
					if (c === '"') {
						closed = true;
						break;
					}
					quotedEmpty = false;
					if (c === "\\") {
						const n = src[j + 1];
						if (n === "\n") {
							j += 2;
							continue;
						}
						if (n === '"' || n === "\\" || n === "$" || n === "`") {
							pushLit(n, true);
							j += 2;
							continue;
						}
						pushLit("\\", true);
						j++;
						continue;
					}
					if (c === "$") {
						const consumed = this.readDollar(src, j, parts, flush, true);
						if (consumed > 0) {
							j += consumed;
							continue;
						}
						pushLit("$", true);
						j++;
						continue;
					}
					if (c === "`") {
						const end = findBacktick(src, j + 1);
						if (end < 0) throw new ParseError("unterminated backtick");
						const inner = src.slice(j + 1, end).replace(/\\`/g, "`");
						flush();
						parts.push({ kind: "cmd", body: this.sub(inner), raw: src.slice(j, end + 1) });
						j = end + 1;
						continue;
					}
					pushLit(c, true);
					j++;
				}
				if (!closed) throw new ParseError("unterminated double quote");
				if (quotedEmpty) {
					flush();
					parts.push({ kind: "lit", text: "", quoted: true });
				}
				i = j + 1;
				continue;
			}
			if (ch === "$") {
				const consumed = this.readDollar(src, i, parts, flush, false);
				if (consumed > 0) {
					i += consumed;
					continue;
				}
				pushLit("$", false);
				i++;
				continue;
			}
			if (ch === "`") {
				const end = findBacktick(src, i + 1);
				if (end < 0) throw new ParseError("unterminated backtick");
				const inner = src.slice(i + 1, end).replace(/\\`/g, "`");
				flush();
				parts.push({ kind: "cmd", body: this.sub(inner), raw: src.slice(i, end + 1) });
				i = end + 1;
				continue;
			}
			if (ch === "~" && i === from && lit.length === 0 && parts.length === 0) {
				let j = i + 1;
				while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j])) j++;
				const user = src.slice(i + 1, j);
				// only a tilde prefix when followed by `/`, end of word, or nothing
				if (j >= src.length || src[j] === "/" || /\s/.test(src[j]) || OPERATOR_CHARS.has(src[j]) || src[j] === ":") {
					parts.push({ kind: "tilde", user });
					i = j;
					continue;
				}
			}
			if (ch === "*" || ch === "?" || ch === "[" || ch === "{") {
				// glob / brace expansion marker (unquoted)
				if (ch === "{" && !/^\{[^\s{}]*,[^\s{}]*\}|^\{\d+\.\.\d+\}/.test(src.slice(i))) {
					pushLit(ch, false);
					i++;
					continue;
				}
				if (ch === "[") {
					// A bracket expression closes inside the word; `[ -d x ]` is the test builtin.
					const close = src.indexOf("]", i + 1);
					if (close < 0 || /[\s|&;<>()]/.test(src.slice(i + 1, close))) {
						pushLit(ch, false);
						i++;
						continue;
					}
				}
				flush();
				if (ch === "{") {
					const close = src.indexOf("}", i);
					if (/[$`<>\\]/.test(src.slice(i, close + 1))) throw new ParseError("expanding brace expression requires review");
					parts.push({ kind: "glob", text: src.slice(i, close + 1) });
					i = close + 1;
					continue;
				}
				parts.push({ kind: "glob", text: ch });
				i++;
				continue;
			}
			pushLit(ch, false);
			i++;
		}
		flush();
		this.pos = i;
		return { type: "word", word: { parts, raw: src.slice(from, i) }, pos: from };
	}

	/** Parses `$...` at src[i]. Returns the number of chars consumed (0 if not an expansion). */
	private readDollar(src: string, i: number, parts: WordPart[], flush: () => void, _inDq: boolean): number {
		const n1 = src[i + 1];
		if (n1 === "[") throw new ParseError("legacy arithmetic expansion requires review");
		if (n1 === "(") {
			if (src[i + 2] === "(") {
				const end = findDoubleParenClose(src, i + 1);
				if (end < 0 || !/^[\d\s()+*/%<>=!&|^~?:.-]+$/.test(src.slice(i + 3, end - 2))) {
					throw new ParseError("non-numeric arithmetic expansion requires review");
				}
				flush();
				parts.push({ kind: "arith", raw: src.slice(i, end) });
				return end - i;
			}
			const { body, end } = this.subCommand(i + 2);
			flush();
			parts.push({ kind: "cmd", body, raw: src.slice(i, end) });
			return end - i;
		}
		if (n1 === "{") {
			const end = findClosing(src, i + 1, "{", "}");
			if (end < 0) throw new ParseError("unterminated ${");
			const name = src.slice(i + 2, end);
			if (!/^[A-Za-z_][A-Za-z0-9_]*(?:(?:##?|%%?|:?-)[^$`\\[\]{}<>]*)?$/.test(name)) {
				throw new ParseError("complex parameter expansion requires review");
			}
			flush();
			parts.push({ kind: "var", name });
			return end + 1 - i;
		}
		if (n1 !== undefined && /[A-Za-z_]/.test(n1)) {
			let j = i + 1;
			while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
			flush();
			parts.push({ kind: "var", name: src.slice(i + 1, j) });
			return j - i;
		}
		if (n1 !== undefined && /[0-9@*#?$!\-]/.test(n1)) {
			flush();
			parts.push({ kind: "var", name: n1 });
			return 2;
		}
		return 0;
	}

	private sub(inner: string): List {
		if (this.depth >= MAX_DEPTH) throw new ParseError("nesting too deep");
		return parseInternal(inner, this.depth + 1);
	}
}

class Parser {
	private i = 0;
	constructor(
		private readonly tokens: Token[],
		private readonly depth: number,
	) {}

	private peek(offset = 0): Token {
		return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
	}
	private take(): Token {
		const t = this.tokens[this.i];
		if (this.i < this.tokens.length - 1) this.i++;
		return t;
	}
	private isOp(t: Token, op: string): boolean {
		return t.type === "op" && t.op === op;
	}
	private isWord(t: Token, text: string): boolean {
		return t.type === "word" && isPlainWord(t.word, text);
	}
	private skipNewlines(): void {
		while (this.peek().type === "newline") this.take();
	}

	parseProgram(): List {
		const list = this.parseList(new Set());
		const t = this.peek();
		if (t.type !== "eof") throw new ParseError(`unexpected ${describe(t)}`);
		return list;
	}

	/** Parses a list until one of the terminator words/ops (not consumed) or eof. */
	parseList(terminators: Set<string>): List {
		const items: ListItem[] = [];
		this.skipNewlines();
		while (true) {
			const t = this.peek();
			if (t.type === "eof") break;
			if (t.type === "op" && (t.op === ")" || t.op === "}" && terminators.has("}") || terminators.has(t.op))) break;
			if (t.type === "word" && terminators.size && isReservedAt(t.word) && terminators.has(plainText(t.word))) break;
			const andor = this.parseAndOr();
			let background = false;
			const sep = this.peek();
			if (sep.type === "op" && (sep.op === ";" || sep.op === "&")) {
				background = sep.op === "&";
				this.take();
			} else if (sep.type === "newline") {
				this.take();
			} else if (sep.type === "eof") {
				items.push({ andor, background });
				break;
			} else if (sep.type === "op" && (sep.op === ")" || sep.op === ";;" || sep.op === ";&" || sep.op === ";;&" || sep.op === "}")) {
				items.push({ andor, background });
				break;
			} else if (sep.type === "word" && terminators.size && isReservedAt(sep.word) && terminators.has(plainText(sep.word))) {
				items.push({ andor, background });
				break;
			} else {
				throw new ParseError(`unexpected ${describe(sep)}`);
			}
			items.push({ andor, background });
			this.skipNewlines();
		}
		return { items };
	}

	private parseAndOr(): AndOr {
		const pipelines: Pipeline[] = [this.parsePipeline()];
		const ops: ("&&" | "||")[] = [];
		while (true) {
			const t = this.peek();
			if (t.type === "op" && (t.op === "&&" || t.op === "||")) {
				this.take();
				ops.push(t.op);
				this.skipNewlines();
				pipelines.push(this.parsePipeline());
			} else break;
		}
		return { pipelines, ops };
	}

	private parsePipeline(): Pipeline {
		let negated = false;
		let timed = false;
		while (true) {
			const t = this.peek();
			if (this.isWord(t, "!")) {
				negated = !negated;
				this.take();
			} else if (this.isWord(t, "time")) {
				timed = true;
				this.take();
				if (this.isWord(this.peek(), "-p")) this.take();
			} else break;
		}
		const commands: Command[] = [this.parseCommand()];
		const stderrPipes: boolean[] = [];
		while (true) {
			const t = this.peek();
			if (t.type === "op" && (t.op === "|" || t.op === "|&")) {
				this.take();
				stderrPipes.push(t.op === "|&");
				this.skipNewlines();
				commands.push(this.parseCommand());
			} else break;
		}
		return { commands, negated, timed, stderrPipes };
	}

	private parseRedirectsAfter(): Redirect[] {
		const redirects: Redirect[] = [];
		while (this.peek().type === "redirect") redirects.push((this.take() as Extract<Token, { type: "redirect" }>).redirect);
		return redirects;
	}

	private parseCommand(): Command {
		const t = this.peek();
		if (t.type === "op") {
			if (t.op === "(") {
				this.take();
				const body = this.parseList(new Set([")"]));
				this.expectOp(")");
				return { type: "subshell", body, redirects: this.parseRedirectsAfter() };
			}
			throw new ParseError(`unexpected ${describe(t)}`);
		}
		if (t.type === "word" && isReservedAt(t.word)) {
			const kw = plainText(t.word);
			switch (kw) {
				case "{": {
					this.take();
					const body = this.parseList(new Set(["}"]));
					this.expectWord("}");
					return { type: "group", body, redirects: this.parseRedirectsAfter() };
				}
				case "if":
					return this.parseIf();
				case "for":
				case "select":
					return this.parseFor();
				case "while":
				case "until":
					return this.parseWhile(kw === "until");
				case "case":
					return this.parseCase();
				case "function": {
					this.take();
					const nameTok = this.take();
					if (nameTok.type !== "word") throw new ParseError("bad function name");
					if (this.isOp(this.peek(), "(")) {
						this.take();
						this.expectOp(")");
					}
					this.skipNewlines();
					const body = this.parseCommand();
					return { type: "function", name: plainText(nameTok.word), body, redirects: [] };
				}
				case "coproc": {
					throw new ParseError("coprocess requires review");
				}
				default:
					throw new ParseError(`unexpected keyword ${kw}`);
			}
		}
		// function definition: name ( ) compound
		if (t.type === "word" && NAME_RE.test(plainText(t.word)) && this.isOp(this.peek(1), "(") && this.isOp(this.peek(2), ")")) {
			const name = plainText(t.word);
			this.take();
			this.take();
			this.take();
			this.skipNewlines();
			const body = this.parseCommand();
			return { type: "function", name, body, redirects: [] };
		}
		return this.parseSimple();
	}

	private parseSimple(): SimpleCommand {
		const cmd: SimpleCommand = { type: "simple", assignments: [], words: [], redirects: [] };
		let sawWord = false;
		while (true) {
			const t = this.peek();
			if (t.type === "redirect") {
				cmd.redirects.push(t.redirect);
				this.take();
				continue;
			}
			if (t.type !== "word") break;
			// reserved words are only recognized in command position (`echo done` is fine)
			if (!sawWord && cmd.assignments.length === 0 && isReservedAt(t.word) && plainText(t.word) !== "in") break;
			if (!sawWord) {
				const assignment = asAssignment(t.word);
				if (assignment) {
					cmd.assignments.push(assignment);
					this.take();
					continue;
				}
			}
			sawWord = true;
			cmd.words.push(t.word);
			this.take();
		}
		if (cmd.words.length === 0 && cmd.assignments.length === 0 && cmd.redirects.length === 0) {
			throw new ParseError(`unexpected ${describe(this.peek())}`);
		}
		return cmd;
	}

	private parseIf(): IfCommand {
		this.expectWord("if");
		const clauses: { cond: List; body: List }[] = [];
		let cond = this.parseList(new Set(["then"]));
		this.expectWord("then");
		let body = this.parseList(new Set(["elif", "else", "fi"]));
		clauses.push({ cond, body });
		let elseBody: List | undefined;
		while (true) {
			const t = this.peek();
			if (this.isWord(t, "elif")) {
				this.take();
				cond = this.parseList(new Set(["then"]));
				this.expectWord("then");
				body = this.parseList(new Set(["elif", "else", "fi"]));
				clauses.push({ cond, body });
			} else if (this.isWord(t, "else")) {
				this.take();
				elseBody = this.parseList(new Set(["fi"]));
			} else break;
		}
		this.expectWord("fi");
		return { type: "if", clauses, elseBody, redirects: this.parseRedirectsAfter() };
	}

	private parseFor(): ForCommand {
		this.take(); // for / select
		const nameTok = this.take();
		if (nameTok.type !== "word") throw new ParseError("bad for loop");
		const rawName = plainText(nameTok.word);
		let words: Word[] | undefined;
		let arith: string | undefined;
		if (rawName.startsWith("((")) {
			// `for (( init; cond; step ))` is lexed as one word by the arithmetic rule
			arith = nameTok.word.raw;
		} else {
			this.skipNewlinesAndSemis();
			if (this.isWord(this.peek(), "in")) {
				this.take();
				words = [];
				while (this.peek().type === "word") words.push((this.take() as Extract<Token, { type: "word" }>).word);
			}
		}
		this.skipNewlinesAndSemis();
		const body = this.parseDoBody();
		return { type: "for", varName: rawName, words, arith, body, redirects: this.parseRedirectsAfter() };
	}

	private skipNewlinesAndSemis(): void {
		while (this.peek().type === "newline" || this.isOp(this.peek(), ";")) this.take();
	}

	private parseDoBody(): List {
		this.expectWord("do");
		const body = this.parseList(new Set(["done"]));
		this.expectWord("done");
		return body;
	}

	private parseWhile(until: boolean): WhileCommand {
		this.take();
		const cond = this.parseList(new Set(["do"]));
		const body = this.parseDoBody();
		return { type: "while", until, cond, body, redirects: this.parseRedirectsAfter() };
	}

	private parseCase(): CaseCommand {
		this.expectWord("case");
		const wordTok = this.take();
		if (wordTok.type !== "word") throw new ParseError("bad case");
		this.skipNewlines();
		this.expectWord("in");
		this.skipNewlines();
		const items: { patterns: Word[]; body: List }[] = [];
		while (!this.isWord(this.peek(), "esac")) {
			if (this.peek().type === "eof") throw new ParseError("unterminated case");
			if (this.isOp(this.peek(), "(")) this.take();
			const patterns: Word[] = [];
			while (true) {
				const p = this.take();
				if (p.type !== "word") throw new ParseError("bad case pattern");
				patterns.push(p.word);
				if (this.isOp(this.peek(), "|")) {
					this.take();
					continue;
				}
				break;
			}
			this.expectOp(")");
			const body = this.parseList(new Set(["esac", ";;"]));
			const sep = this.peek();
			if (sep.type === "op" && (sep.op === ";;" || sep.op === ";&" || sep.op === ";;&")) this.take();
			this.skipNewlines();
			items.push({ patterns, body });
		}
		this.expectWord("esac");
		return { type: "case", word: wordTok.word, items, redirects: this.parseRedirectsAfter() };
	}

	private expectOp(op: string): void {
		const t = this.take();
		if (!this.isOp(t, op)) throw new ParseError(`expected ${op} but found ${describe(t)}`);
	}
	private expectWord(text: string): void {
		const t = this.take();
		if (!this.isWord(t, text)) throw new ParseError(`expected ${text} but found ${describe(t)}`);
	}
}

function describe(t: Token): string {
	if (t.type === "word") return `word "${t.word.raw}"`;
	if (t.type === "op") return `"${t.op}"`;
	if (t.type === "redirect") return `redirect ${t.redirect.op}`;
	return t.type;
}

function isPlainWord(word: Word, text: string): boolean {
	return word.parts.length === 1 && word.parts[0].kind === "lit" && !word.parts[0].quoted && word.parts[0].text === text;
}

/** True when the word is an unquoted reserved word. */
function isReservedAt(word: Word): boolean {
	if (word.parts.length !== 1) return false;
	const p = word.parts[0];
	return p.kind === "lit" && !p.quoted && RESERVED.has(p.text);
}

function asAssignment(word: Word): Assignment | undefined {
	const first = word.parts[0];
	if (!first || first.kind !== "lit" || first.quoted) return undefined;
	const m = ASSIGNMENT_RE.exec(first.text);
	if (!m) return undefined;
	if (m[0].includes("[")) throw new ParseError("array assignments require review");
	const eq = first.text.indexOf("=");
	const namePart = first.text.slice(0, eq);
	const append = namePart.endsWith("+");
	const name = append ? namePart.slice(0, -1) : namePart;
	const rest = first.text.slice(eq + 1);
	const parts: WordPart[] = [];
	if (rest.length) parts.push({ kind: "lit", text: rest, quoted: false });
	parts.push(...word.parts.slice(1));
	return { name, value: { parts, raw: word.raw.slice(eq + 1) }, append };
}

/** Concatenation of literal parts; expansions are rendered in `$NAME` form. */
export function plainText(word: Word): string {
	let out = "";
	for (const p of word.parts) {
		switch (p.kind) {
			case "lit":
				out += p.text;
				break;
			case "var":
				out += `$${p.name.length === 1 || /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name) ? p.name : `{${p.name}}`}`;
				break;
			case "cmd":
			case "arith":
			case "proc":
				out += p.raw;
				break;
			case "glob":
				out += p.text;
				break;
			case "tilde":
				out += `~${p.user}`;
				break;
		}
	}
	return out;
}

/** Literal text only if the word has no expansions or globs (tilde allowed, resolved by caller). */
export function literalText(word: Word): string | undefined {
	let out = "";
	for (const p of word.parts) {
		if (p.kind === "lit") out += p.text;
		else if (p.kind === "tilde") out += `~${p.user}`;
		else return undefined;
	}
	return out;
}

export function hasExpansion(word: Word): boolean {
	return word.parts.some((p) => p.kind === "var" || p.kind === "cmd" || p.kind === "arith" || p.kind === "proc");
}

export function hasGlob(word: Word): boolean {
	return word.parts.some((p) => p.kind === "glob");
}

/** All nested lists inside a word (command substitutions, process substitutions). */
export function nestedLists(word: Word): List[] {
	const lists: List[] = [];
	for (const p of word.parts) if (p.kind === "cmd" || p.kind === "proc") lists.push(p.body);
	return lists;
}

function parseInternal(src: string, depth: number): List {
	const tokens = new Lexer(src, depth).lex();
	return new Parser(tokens, depth).parseProgram();
}

export function parseCommand(src: string): ParseResult {
	try {
		const list = parseInternal(src, 0);
		return { ok: true, list };
	} catch (err) {
		return { ok: false, list: { items: [] }, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Visits command syntax depth-first, including uncalled function bodies. Not execution order. */
export function* iterateCommands(list: List): Generator<Command> {
	for (const item of list.items) {
		for (const pipeline of item.andor.pipelines) {
			for (const command of pipeline.commands) {
				yield command;
				yield* iterateNested(command);
			}
		}
	}
}

function* iterateNested(command: Command): Generator<Command> {
	for (const redirect of command.redirects) {
		if (redirect.target) for (const list of nestedLists(redirect.target)) yield* iterateCommands(list);
	}
	switch (command.type) {
		case "simple":
			for (const w of [...command.assignments.map((a) => a.value), ...command.words]) {
				for (const l of nestedLists(w)) yield* iterateCommands(l);
			}
			break;
		case "subshell":
		case "group":
			yield* iterateCommands(command.body);
			break;
		case "if":
			for (const c of command.clauses) {
				yield* iterateCommands(c.cond);
				yield* iterateCommands(c.body);
			}
			if (command.elseBody) yield* iterateCommands(command.elseBody);
			break;
		case "for":
			for (const w of command.words ?? []) for (const l of nestedLists(w)) yield* iterateCommands(l);
			yield* iterateCommands(command.body);
			break;
		case "while":
			yield* iterateCommands(command.cond);
			yield* iterateCommands(command.body);
			break;
		case "case":
			for (const l of nestedLists(command.word)) yield* iterateCommands(l);
			for (const item of command.items) {
				for (const word of item.patterns) for (const list of nestedLists(word)) yield* iterateCommands(list);
				yield* iterateCommands(item.body);
			}
			break;
		case "function":
			yield command.body;
			yield* iterateNested(command.body);
			break;
		default:
			break;
	}
}
