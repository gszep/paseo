import type { TextStyle } from "react-native";
import type { MarkdownStyles } from "./renderer";

export interface MarkdownMathProps {
  markup: string;
  tex: string;
  styles: MarkdownStyles;
  inheritedStyles: TextStyle;
}
