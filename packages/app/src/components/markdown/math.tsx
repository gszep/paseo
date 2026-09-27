import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { MarkdownTextSpan } from "@/components/markdown-text";
import { mathSource } from "@/utils/markdown-math";
import type { MarkdownMathProps } from "./math-types";

// Native has no KaTeX: text there is a native text view, so math shows its
// TeX source on the code surfaces.
export function MarkdownInlineMath({ markup, tex, styles, inheritedStyles }: MarkdownMathProps) {
  return (
    <MarkdownTextSpan style={[inheritedStyles, styles.code_inline]} monoSurface copyTag="code">
      {mathSource({ markup, content: tex })}
    </MarkdownTextSpan>
  );
}

export function MarkdownBlockMath({ tex, styles, inheritedStyles }: MarkdownMathProps) {
  return (
    <HighlightedCodeBlock
      code={tex}
      language="latex"
      inheritedStyles={inheritedStyles}
      textStyle={styles.fence}
    />
  );
}
