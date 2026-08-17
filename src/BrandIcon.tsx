import type { BrandPreset } from "./types";

interface BrandIconProps {
  preset?: BrandPreset;
  size?: number;
  className?: string;
}

const BRAND_ICON_URLS: Record<BrandPreset, string> = {
  amber: "/app-icon.svg",
  verdant: "/app-icon-verdant.svg",
  azure: "/app-icon-azure.svg",
};

export function brandIconUrl(preset: BrandPreset): string {
  return BRAND_ICON_URLS[preset];
}

export function BrandIcon({ preset = "amber", size = 20, className }: BrandIconProps) {
  return (
    <img
      className={className}
      src={brandIconUrl(preset)}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
