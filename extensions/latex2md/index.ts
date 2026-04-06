import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Converts common LaTeX formatting commands to Markdown.
 * This implementation handles nested commands by repeatedly applying replacements
 * until no more changes are detected.
 */
function latexToMarkdown(text: string): string {
  let prevText = "";
  let currentText = text;

  // Limit iterations to prevent infinite loops in case of malicious LaTeX
  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (prevText !== currentText && iterations < MAX_ITERATIONS) {
    prevText = currentText;
    iterations++;

    // 1. Text Styling (Nested)
    currentText = currentText
      .replace(/\\textbf\{((?:[^{}]|\{[^{}]*\})*)\}/g, "**$1**")
      .replace(/\\textit\{((?:[^{}]|\{[^{}]*\})*)\}/g, "*$1*")
      .replace(/\\emph\{((?:[^{}]|\{[^{}]*\})*)\}/g, "*$1*")
      .replace(/\\underline\{((?:[^{}]|\{[^{}]*\})*)\}/g, "==$1==")
      .replace(/\\text\{((?:[^{}]|\{[^{}]*\})*)\}/g, "$1")
      .replace(/\\fbox\{((?:[^{}]|\{[^{}]*\})*)\}/g, "[$1]");

    // 2. Headers
    currentText = currentText
      .replace(/\\section\{((?:[^{}]|\{[^{}]*\})*)\}/g, "\n# $1")
      .replace(/\\subsection\{((?:[^{}]|\{[^{}]*\})*)\}/g, "\n## $1")
      .replace(/\\subsubsection\{((?:[^{}]|\{[^{}]*\})*)\}/g, "\n### $1")

    // 3. Math Blocks (Environments)
    // Convert \begin{equation}...\end{equation} or \begin{align}...\end{align} to $$...$$
    currentText = currentText.replace(/\\begin\{(equation|align|gather|multline)\}([\s\S]*?)\\end\{\1\}/g, (_, __, content) => {
      return `\n$$\n${content.trim()}\n$$\n`;
    });

    // 4. Lists
    // Handle itemize
    currentText = currentText.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, (_, content) => {
      const items = content.split(/\\item/).map(s => s.trim()).filter(Boolean);
      if (items.length === 0) return "";
      return "\n" + items
        .map(item => `- ${item.trim()}`)
        .join("\n");
    });

    // Handle enumerate
    currentText = currentText.replace(/\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g, (_, content) => {
      const items = content.split(/\\item/).map(s => s.trim()).filter(Boolean);
      if (items.length === 0) return "";
      return "\n" + items
        .map((item, idx) => `${idx + 1}. ${item.trim()}`)
        .join("\n");
    });
  }

  // 5. Common Math Symbols
  currentText = currentText
    .replace(/\\Rightarrow/g, "=>")
    .replace(/\\Leftarrow/g, "<=")
    .replace(/\\Leftrightarrow/g, "<=>")
    .replace(/\\rightarrow/g, "->")
    .replace(/\\leftarrow/g, "<-")
    .replace(/\\implies/g, "=>")
    .replace(/\\iff/g, "<=>")
    .replace(/\\approx/g, "≈")
    .replace(/\\sim/g, "~")
    .replace(/\\neq/g, "≠")
    .replace(/\\le/g, "≤")
    .replace(/\\ge/g, "≥")
    .replace(/\\pm/g, "±")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\infty/g, "∞")
    .replace(/\\gg/g, "≫")
    .replace(/\\ll/g, "≪")
    .replace(/\\cup/g, "∪")
    .replace(/\\cap/g, "∩")
    .replace(/\\xrightarrow\{([^}]*)\}/g, "—($1)→");




  // 6. Delimiters
  // Block math: $$...$$ -> ensure newlines
  currentText = currentText.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, "\n$$\n$1\n$$\n");

  // Inline math: $...$ -> remove delimiters if NO LaTeX commands remain
  currentText = currentText.replace(/\$([^\$\n\r]*?)\$/g, (_, content) => {
    if (content.includes('\\')) {
      return `$${content}$`;
    }
    return content;
  });


  // 6. Cleanup remaining LaTeX artifacts
  // Remove common LaTeX escapes that don't have a direct Markdown equivalent but clutter output
  currentText = currentText
    .replace(/\\noindent\s*/g, "")
    .replace(/\\par\s*/g, "\n\n")
    .replace(/\\quad\s*/g, "  ")
    .replace(/\\qquad\s*/g, "    ")
    .replace(/\\hspace\{[^}]*\}/g, " ")
    .replace(/\\vspace\{[^}]*\}/g, "")
    .replace(/\\newpage\s*/g, "\n\n")
    .replace(/\\clearpage\s*/g, "\n\n")
    .replace(/\\pagebreak\s*/g, "\n\n")
    .replace(/\label\{[^}]*\}/g, "")
    .replace(/\s+\ref\{[^}]*\}/g, " [ref]")
    .replace(/\s+\cite\{[^}]*\}/g, " [citation]");

  return currentText;
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event, _ctx) => {
    const { message } = event;

    // Only process assistant messages
    if (message.role !== "assistant") return;

    let modified = false;

    // Content is an array of blocks
    for (const block of message.content) {
      if (block.type === "text") {
        const originalText = block.text;
        const convertedText = latexToMarkdown(originalText);
        
        if (originalText !== convertedText) {
          block.text = convertedText;
          modified = true;
        }
      }
    }

    // Note: message_end event in pi allows in-place mutation of the message object
    // which will then be reflected in the session history and TUI rendering.
  });
}
