import Svg, { Path } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";
import { BRAND } from "@/branding/brand";

interface PaseoLogoProps {
  size?: number;
  color?: string;
}

/**
 * The app mark. Uses the active brand's mark paths, so hosted builds render the
 * configured brand while native/desktop keep the default Paseo mark.
 */
export function PaseoLogo({ size = 64, color }: PaseoLogoProps) {
  const { theme } = useUnistyles();
  const fill = color ?? theme.colors.foreground;
  const mark = BRAND.mark;

  return (
    <Svg width={size} height={size} viewBox={mark.viewBox} fill="none">
      {mark.paths.map((path) => (
        <Path key={path} d={path} fill={fill} />
      ))}
    </Svg>
  );
}
