import type MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";

const CLOSING_DELIMITER: Record<string, string> = {
  $: "$",
  $$: "$$",
  "\\(": "\\)",
  "\\[": "\\]",
};
const INLINE_OPENERS = ["$$", "$", "\\("];
const BLOCK_OPENERS = ["$$", "\\["];

export function isDisplayMath(markup: string): boolean {
  return markup === "$$" || markup === "\\[";
}

/** The math span as the author wrote it, delimiters included. */
export function mathSource(token: Pick<Token, "markup" | "content">): string {
  return `${token.markup}${token.content}${CLOSING_DELIMITER[token.markup] ?? ""}`;
}

/**
 * Adds `math_inline` tokens for `$…$`, `$$…$$` and `\(…\)`, and `math_block`
 * tokens for `$$…$$` and `\[…\]` that start a line. `\[` is block-only because
 * markdown writes `\[1\]` for literal brackets.
 *
 * `$…$` follows pandoc: no whitespace just inside either `$`, and the closing
 * `$` is not followed by a digit, so "costs $5 and $10" stays text. The first
 * unescaped `$` closes the span; if it is not a valid closer, the opener is text.
 * Math never opens or closes inside a code span or block.
 */
export function enableMarkdownMath(parser: MarkdownIt): void {
  parser.inline.ruler.before("escape", "math_inline", mathInline);
  parser.block.ruler.after("fence", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  const escapeHtml = parser.utils.escapeHtml;
  parser.renderer.rules.math_inline = (tokens, index) => escapeHtml(mathSource(tokens[index]));
  parser.renderer.rules.math_block = (tokens, index) =>
    `<p>${escapeHtml(mathSource(tokens[index]))}</p>\n`;
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state;
  const markup = INLINE_OPENERS.find((opener) => src.startsWith(opener, pos));
  if (!markup) return false;

  const closing = CLOSING_DELIMITER[markup];
  const start = pos + markup.length;
  const end = findClosingDelimiter(src, start, posMax, closing);
  if (end === -1 || src.slice(start, end).trim().length === 0) return false;
  if (
    markup === "$" &&
    (/\s/.test(src[start]) || /\s/.test(src[end - 1]) || /\d/.test(src[end + 1] ?? ""))
  ) {
    return false;
  }

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = markup;
    token.content = src.slice(start, end).trim();
  }
  state.pos = end + closing.length;
  return true;
}

function findClosingDelimiter(src: string, from: number, max: number, closing: string): number {
  for (let index = from; index < max; index += 1) {
    if (src.startsWith(closing, index)) {
      return index + closing.length <= max ? index : -1;
    }
    if (src[index] === "\\") {
      index += 1;
    } else if (src[index] === "`") {
      index = skipCodeSpan(src, index, max) - 1;
    }
  }
  return -1;
}

// Code spans bind tighter than math, so a `$` inside one never closes math.
function skipCodeSpan(src: string, start: number, max: number): number {
  const runs = /`+/g;
  runs.lastIndex = start;
  const opening = runs.exec(src)![0];
  for (let run = runs.exec(src); run && run.index < max; run = runs.exec(src)) {
    if (run[0].length === opening.length) return run.index + opening.length;
  }
  return start + opening.length;
}

function mathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;

  const firstLine = lineText(state, startLine);
  const markup = BLOCK_OPENERS.find((opener) => firstLine.startsWith(opener));
  if (!markup) return false;
  const closing = CLOSING_DELIMITER[markup];

  const lines: string[] = [];
  let line = startLine;
  let text = firstLine.slice(markup.length).trimEnd();
  while (!text.endsWith(closing)) {
    lines.push(text);
    line += 1;
    if (line >= endLine) return false;
    if (state.sCount[line] < state.blkIndent && !state.isEmpty(line)) return false;
    text = lineText(state, line).trimEnd();
  }
  lines.push(text.slice(0, -closing.length));
  const content = lines.join("\n").trim();
  if (content.length === 0) return false;
  if (silent) return true;

  state.line = line + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.markup = markup;
  token.content = content;
  token.map = [startLine, state.line];
  return true;
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}
