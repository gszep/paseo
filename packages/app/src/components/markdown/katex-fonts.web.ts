import { Asset } from "expo-asset";

// katex.min.css points its @font-face rules at a fonts/ directory beside the
// stylesheet, which Metro's CSS export does not copy. Metro does bundle
// required fonts, so these later rules for the same faces take their place.
const KATEX_FONTS: Record<string, number> = {
  "AMS-Regular": require("katex/dist/fonts/KaTeX_AMS-Regular.ttf"),
  "Caligraphic-Bold": require("katex/dist/fonts/KaTeX_Caligraphic-Bold.ttf"),
  "Caligraphic-Regular": require("katex/dist/fonts/KaTeX_Caligraphic-Regular.ttf"),
  "Fraktur-Bold": require("katex/dist/fonts/KaTeX_Fraktur-Bold.ttf"),
  "Fraktur-Regular": require("katex/dist/fonts/KaTeX_Fraktur-Regular.ttf"),
  "Main-Bold": require("katex/dist/fonts/KaTeX_Main-Bold.ttf"),
  "Main-BoldItalic": require("katex/dist/fonts/KaTeX_Main-BoldItalic.ttf"),
  "Main-Italic": require("katex/dist/fonts/KaTeX_Main-Italic.ttf"),
  "Main-Regular": require("katex/dist/fonts/KaTeX_Main-Regular.ttf"),
  "Math-BoldItalic": require("katex/dist/fonts/KaTeX_Math-BoldItalic.ttf"),
  "Math-Italic": require("katex/dist/fonts/KaTeX_Math-Italic.ttf"),
  "SansSerif-Bold": require("katex/dist/fonts/KaTeX_SansSerif-Bold.ttf"),
  "SansSerif-Italic": require("katex/dist/fonts/KaTeX_SansSerif-Italic.ttf"),
  "SansSerif-Regular": require("katex/dist/fonts/KaTeX_SansSerif-Regular.ttf"),
  "Script-Regular": require("katex/dist/fonts/KaTeX_Script-Regular.ttf"),
  "Size1-Regular": require("katex/dist/fonts/KaTeX_Size1-Regular.ttf"),
  "Size2-Regular": require("katex/dist/fonts/KaTeX_Size2-Regular.ttf"),
  "Size3-Regular": require("katex/dist/fonts/KaTeX_Size3-Regular.ttf"),
  "Size4-Regular": require("katex/dist/fonts/KaTeX_Size4-Regular.ttf"),
  "Typewriter-Regular": require("katex/dist/fonts/KaTeX_Typewriter-Regular.ttf"),
};

export function installKatexFonts(): void {
  const style = document.createElement("style");
  style.textContent = Object.entries(KATEX_FONTS)
    .map(([face, font]) => {
      const [family, variant] = face.split("-");
      const weight = variant.includes("Bold") ? 700 : 400;
      const fontStyle = variant.includes("Italic") ? "italic" : "normal";
      const url = Asset.fromModule(font).uri;
      return `@font-face{font-family:KaTeX_${family};font-weight:${weight};font-style:${fontStyle};src:url("${url}") format("truetype")}`;
    })
    .join("\n");
  document.head.append(style);
}
