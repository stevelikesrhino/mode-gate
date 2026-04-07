import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MODEL_FILTER = ["gemma"];

const MATH_SYMBOL_REPLACEMENTS: Record<string, string> = {
  hbar: "ℏ",
  int: "∫",
  partial: "∂",
  nabla: "∇",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  rightarrow: "→",
  to: "→",
  leftarrow: "←",
  gets: "←",
  mapsto: "↦",
  implies: "⇒",
  iff: "⇔",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  land: "∧",
  wedge: "∧",
  lor: "∨",
  vee: "∨",
  uparrow: "↑",
  downarrow: "↓",
  updownarrow: "↕",
  nearrow: "↗",
  searrow: "↘",
  swarrow: "↙",
  nwarrow: "↖",
  approx: "≈",
  equiv: "≡",
  propto: "∝",
  sim: "~",
  simeq: "≃",
  neq: "≠",
  ne: "≠",
  lt: "<",
  gt: ">",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  subseteq: "⊆",
  subset: "⊂",
  supseteq: "⊇",
  supset: "⊃",
  in: "∈",
  notin: "∉",
  ni: "∋",
  emptyset: "∅",
  varnothing: "∅",
  pm: "±",
  mp: "∓",
  times: "×",
  cdot: "·",
  div: "÷",
  ast: "∗",
  star: "⋆",
  oplus: "⊕",
  otimes: "⊗",
  sum: "∑",
  prod: "∏",
  infty: "∞",
  aleph: "ℵ",
  Re: "ℜ",
  Im: "ℑ",
  gg: "≫",
  ll: "≪",
  cup: "∪",
  cap: "∩",
  setminus: "∖",
  cdots: "⋯",
  ldots: "...",
  dots: "...",
  prime: "′",
  degree: "°",
};

function replaceKnownLatexCommands(input: string, replacements: Record<string, string>): string {
  return input.replace(/\\([A-Za-z]+)/g, (fullMatch, name: string) => {
    const replacement = replacements[name];
    return replacement === undefined ? fullMatch : replacement;
  });
}


function skipSpaces(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function parseBraced(text: string, index: number): { content: string; end: number } | undefined {
  let i = skipSpaces(text, index);
  if (text[i] !== "{") return undefined;

  i++; // skip opening {
  let depth = 1;
  const start = i;

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\") {
      // Skip escaped character so braces inside escapes don't affect depth.
      i += 2;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") depth--;

    if (depth === 0) {
      return { content: text.slice(start, i), end: i + 1 };
    }

    i++;
  }

  return undefined;
}

function convertCommands(input: string): string {
  let out = "";
  let i = 0;
  const simpleEscapes: Record<string, string> = {
    "%": "%",
    "$": "$",
    "#": "#",
    "&": "&",
    "_": "_",
    "{": "{",
    "}": "}",
  };

  const formattingCommands: Record<string, (arg: string) => string> = {
    textbf: (arg) => `**${arg}**`,
    textit: (arg) => `*${arg}*`,
    emph: (arg) => `*${arg}*`,
    mathbf: (arg) => `**${arg}**`,
    underline: (arg) => `==${arg}==`,
    texttt: (arg) => `\`${arg}\``,
    text: (arg) => arg,
    textrm: (arg) => arg,
    textsf: (arg) => arg,
    mbox: (arg) => arg,
    fbox: (arg) => `[${arg}]`,
    mathcal: (arg) => arg,
    mathscr: (arg) => arg,
    mathfrak: (arg) => arg,
    mathrm: (arg) => arg,
    mathit: (arg) => arg,
    mathsf: (arg) => arg,
    mathtt: (arg) => arg,
    operatorname: (arg) => arg,
    overline: (arg) => arg,
    underlinebox: (arg) => arg,
    boxed: (arg) => `[${arg}]`,
    sqrt: (arg) => `sqrt(${arg})`,
  };

  while (i < input.length) {
    if (input[i] !== "\\") {
      out += input[i++];
      continue;
    }

    const cmdStart = i;
    i++; // skip backslash

    if (i >= input.length || !/[A-Za-z]/.test(input[i])) {
      // Handle escaped punctuation and hard line breaks.
      const ch = input[i];
      if (ch === "\\") {
        out += "\n";
        i++;
      } else if (ch && simpleEscapes[ch] !== undefined) {
        out += simpleEscapes[ch];
        i++;
      } else {
        out += "\\";
      }
      continue;
    }

    const nameStart = i;
    while (i < input.length && /[A-Za-z]/.test(input[i])) i++;
    const name = input.slice(nameStart, i);

    const oneArg = (formatter: (arg: string) => string): string | undefined => {
      const parsed = parseBraced(input, i);
      if (!parsed) return undefined;
      i = parsed.end;
      return formatter(convertCommands(parsed.content));
    };

    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const first = parseBraced(input, i);
      if (!first) {
        out += input.slice(cmdStart, i);
        continue;
      }
      i = first.end;
      const second = parseBraced(input, i);
      if (!second) {
        out += input.slice(cmdStart, i);
        continue;
      }
      i = second.end;
      out += `(${convertCommands(first.content)})/(${convertCommands(second.content)})`;
      continue;
    }

    if (name === "binom") {
      const first = parseBraced(input, i);
      if (!first) {
        out += input.slice(cmdStart, i);
        continue;
      }
      i = first.end;
      const second = parseBraced(input, i);
      if (!second) {
        out += input.slice(cmdStart, i);
        continue;
      }
      i = second.end;
      out += `C(${convertCommands(first.content)}, ${convertCommands(second.content)})`;
      continue;
    }

    if (name === "section" || name === "subsection" || name === "subsubsection") {
      if (input[i] === "*") i++;
      const parsed = parseBraced(input, i);
      if (!parsed) {
        out += input.slice(cmdStart, i);
        continue;
      }
      i = parsed.end;
      const header = name === "section" ? "#" : name === "subsection" ? "##" : "###";
      out += `\n${header} ${convertCommands(parsed.content).trim()}`;
      continue;
    }

    const formatter = formattingCommands[name];
    if (formatter) {
      const converted = oneArg(formatter);
      if (converted === undefined) {
        out += input.slice(cmdStart, i);
      } else {
        out += converted;
      }
      continue;
    }

    if (name === "left" || name === "right") {
      // \left( ... \right) -> ( ... )
      continue;
    }

    // Unknown command: keep untouched
    out += input.slice(cmdStart, i);
  }

  return out;
}

function findMatchingListEnd(text: string, contentStart: number): { endStart: number; endAfter: number } | undefined {
  const tokenRegex = /\\begin\{(itemize|enumerate)\}|\\end\{(itemize|enumerate)\}/g;
  tokenRegex.lastIndex = contentStart;
  const stack: ("itemize" | "enumerate")[] = ["itemize"]; // placeholder length for depth only

  for (let match = tokenRegex.exec(text); match; match = tokenRegex.exec(text)) {
    if (match[1]) {
      stack.push(match[1] as "itemize" | "enumerate");
    } else {
      stack.pop();
      if (stack.length === 0) {
        return { endStart: match.index, endAfter: tokenRegex.lastIndex };
      }
    }
  }

  return undefined;
}

function parseListItems(content: string): string[] {
  const tokenRegex = /\\begin\{(itemize|enumerate)\}|\\end\{(itemize|enumerate)\}|\\item\b/g;
  const itemStarts: number[] = [];
  const itemTokenStarts: number[] = [];
  let depth = 0;

  for (let match = tokenRegex.exec(content); match; match = tokenRegex.exec(content)) {
    if (match[1]) {
      depth++;
    } else if (match[2]) {
      if (depth > 0) depth--;
    } else if (depth === 0) {
      itemTokenStarts.push(match.index);
      itemStarts.push(tokenRegex.lastIndex);
    }
  }

  if (itemStarts.length === 0) return [];

  const items: string[] = [];
  for (let idx = 0; idx < itemStarts.length; idx++) {
    const start = itemStarts[idx];
    const end = idx + 1 < itemTokenStarts.length ? itemTokenStarts[idx + 1] : content.length;
    const raw = content.slice(start, end).trim();
    if (raw) items.push(raw);
  }

  return items;
}

function convertLists(input: string): string {
  let out = "";
  let i = 0;

  while (i < input.length) {
    const beginMatch = /^\\begin\{(itemize|enumerate)\}/.exec(input.slice(i));
    if (!beginMatch) {
      out += input[i++];
      continue;
    }

    const listType = beginMatch[1] as "itemize" | "enumerate";
    const beginLen = beginMatch[0].length;
    const contentStart = i + beginLen;
    const listEnd = findMatchingListEnd(input, contentStart);

    if (!listEnd) {
      // Unbalanced list environment; keep raw text.
      out += input.slice(i, contentStart);
      i = contentStart;
      continue;
    }

    const content = input.slice(contentStart, listEnd.endStart);
    const items = parseListItems(content);

    if (items.length === 0) {
      i = listEnd.endAfter;
      continue;
    }

    const convertedItems = items.map((item, idx) => {
      const converted = convertStructure(item).trim();
      const prefix = listType === "itemize" ? "- " : `${idx + 1}. `;
      return `${prefix}${converted}`;
    });

    out += `\n${convertedItems.join("\n")}`;
    i = listEnd.endAfter;
  }

  return out;
}

function convertMathEnvironments(input: string): string {
  return input.replace(/\\begin\{(equation|align|gather|multline)\}([\s\S]*?)\\end\{\1\}/g, (_m, _env, content) => {
    return `\n$$\n${content.trim()}\n$$\n`;
  });
}

function convertDisplayMathDelimiters(input: string): string {
  return input.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, content) => {
    return `\n$$\n${content.trim()}\n$$\n`;
  });
}

function convertArrayEnvironments(input: string): string {
  return input.replace(/\\begin\{array\}\{[^}]*\}([\s\S]*?)\\end\{array\}/g, (_m, content) => {
    const rows = content
      .split(/\\\\/)
      .map((row) => row.replace(/\\hline/g, "").trim())
      .map((row) => row.replace(/\s*&\s*/g, " | "))
      .map((row) => convertCommands(row).trim())
      .filter(Boolean);

    if (rows.length === 0) return "";
    return `\n${rows.join("\n")}\n`;
  });
}

function convertStructure(text: string): string {
  let prev = "";
  let current = text;

  let iterations = 0;
  const MAX_ITERATIONS = 8;

  while (current !== prev && iterations < MAX_ITERATIONS) {
    prev = current;
    iterations++;
    current = convertDisplayMathDelimiters(current);
    current = convertMathEnvironments(current);
    current = convertArrayEnvironments(current);
    current = convertLists(current);
    current = convertCommands(current);
  }

  return current;
}

/**
 * Converts common LaTeX formatting commands to Markdown.
 * This implementation keeps symbol conversion and cleanup behavior intact.
 */
function latexToMarkdown(text: string): string {
  let currentText = convertStructure(text);

  // 5. Common Math Symbols
  currentText = replaceKnownLatexCommands(currentText, MATH_SYMBOL_REPLACEMENTS)
    .replace(/\\%/g, "%")
    .replace(/\\xrightarrow\{([^}]*)\}/g, "—($1)→")
    .replace(/\\xleftarrow\{([^}]*)\}/g, "←($1)—")
    .replace(/\\xRightarrow\{([^}]*)\}/g, "⇒($1)")
    .replace(/\\xLeftarrow\{([^}]*)\}/g, "⇐($1)")
    .replace(/\\xLeftrightarrow\{([^}]*)\}/g, "⇔($1)")
    .replace(/\\xleftrightarrow\{([^}]*)\}/g, "↔($1)");

  // 6. Delimiters
  // Block math: $$...$$ -> ensure newlines
  currentText = currentText.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, "\n$$\n$1\n$$\n");

  // Inline math: $...$ -> remove delimiters if NO LaTeX commands remain
  currentText = currentText.replace(/\$([^\$\n\r]*?)\$/g, (_, content) => {
    if (/\\[A-Za-z]+/.test(content)) {
      return `$${content}$`;
    }
    return content;
  });

  // 7. Cleanup remaining LaTeX artifacts
  currentText = currentText
    .replace(/\\noindent(?=[^A-Za-z]|$)\s*/g, "")
    .replace(/\\par(?=[^A-Za-z]|$)\s*/g, "\n\n")
    .replace(/\\quad(?=[^A-Za-z]|$)\s*/g, "  ")
    .replace(/\\qquad(?=[^A-Za-z]|$)\s*/g, "    ")
    .replace(/\\hspace\{[^}]*\}/g, " ")
    .replace(/\\vspace\{[^}]*\}/g, "")
    .replace(/\\newpage(?=[^A-Za-z]|$)\s*/g, "\n\n")
    .replace(/\\clearpage(?=[^A-Za-z]|$)\s*/g, "\n\n")
    .replace(/\\pagebreak(?=[^A-Za-z]|$)\s*/g, "\n\n")
    .replace(/\\label\{[^}]*\}/g, "")
    .replace(/\s+\\ref\{[^}]*\}/g, " [ref]")
    .replace(/\s+\\cite\{[^}]*\}/g, " [citation]");

  return currentText;
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event, ctx) => {
    const { message } = event;

    if (message.role !== "assistant") return;

    if (MODEL_FILTER.length > 0) {
      const modelId = ctx.model?.id ?? "";
      if (!MODEL_FILTER.some(filter => modelId.toLowerCase().includes(filter.toLowerCase()))) {
        return;
      }
    }

    for (const block of message.content) {

      if (block.type !== "text") continue;

      const originalText = block.text;
      const convertedText = latexToMarkdown(originalText);

      if (originalText !== convertedText) {
        block.text = convertedText;
      }
    }
  });
}
