interface BrandIconProps {
  size?: number;
  className?: string;
}

export function BrandIcon({ size = 20, className }: BrandIconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <circle cx="12" cy="12" r="7.1" stroke="var(--accent, transparent)" strokeWidth=".7" opacity=".3" />
      <circle cx="12" cy="12" r="5.25" stroke="var(--accent, transparent)" strokeWidth=".5" opacity=".2" />
      <circle cx="12" cy="12" r="3" fill="var(--accent, transparent)" />
      <circle cx="12" cy="12" r=".8" fill="currentColor" />
    </svg>
  );
}
