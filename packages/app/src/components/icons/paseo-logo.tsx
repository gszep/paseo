import Svg, { Path } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";
import { BRAND } from "@/branding/brand";

interface PaseoLogoProps {
  size?: number;
  color?: string;
}

export function PaseoLogo({ size = 64, color }: PaseoLogoProps) {
  const { theme } = useUnistyles();
  const fill = color ?? theme.colors.foreground;

  return (
    <Svg width={size} height={size} viewBox={BRAND.mark.viewBox} fill="none">
      {BRAND.mark.paths.map((path) => (
        <Path key={path} d={path} fill={fill} />
      ))}
    </Svg>
  );
}
