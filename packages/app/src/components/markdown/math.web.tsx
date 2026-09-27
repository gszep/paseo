import { useMemo, type CSSProperties } from "react";
import { renderToString } from "katex";
import "katex/dist/katex.min.css";
import { MarkdownTextSpan } from "@/components/markdown-text";
import { isDisplayMath } from "@/utils/markdown-math";
import { installKatexFonts } from "./katex-fonts.web";
import type { MarkdownMathProps } from "./math-types";

installKatexFonts();

// KaTeX escapes its input and, without `trust`, emits no links, classes or
// styles taken from the source, so its HTML is safe to inject. `data-pmono`
// exempts it from the app-wide UI font rule (apply-root-font.web.ts), which
// would otherwise replace the math fonts.
function renderMath(tex: string, displayMode: boolean): { __html: string } {
  return { __html: renderToString(tex, { displayMode, throwOnError: false }) };
}

export function MarkdownInlineMath({ markup, tex, styles, inheritedStyles }: MarkdownMathProps) {
  const html = useMemo(() => renderMath(tex, isDisplayMath(markup)), [markup, tex]);
  const style = useMemo(() => [inheritedStyles, styles.text], [inheritedStyles, styles.text]);
  return (
    <MarkdownTextSpan style={style}>
      <span data-pmono="" dangerouslySetInnerHTML={html} />
    </MarkdownTextSpan>
  );
}

export function MarkdownBlockMath({ tex, styles }: MarkdownMathProps) {
  const html = useMemo(() => renderMath(tex, true), [tex]);
  const { color, fontSize } = styles.body;
  // A plain div inherits no text styles from the surrounding views.
  const style = useMemo<CSSProperties>(
    () => ({
      color: typeof color === "string" ? color : undefined,
      fontSize,
      overflowX: "auto",
      overflowY: "hidden",
    }),
    [color, fontSize],
  );
  return <div data-pmono="" style={style} dangerouslySetInnerHTML={html} />;
}
