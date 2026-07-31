interface BrandIconProps {
  size?: number;
  className?: string;
}

export function BrandIcon({ size = 20, className }: BrandIconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path d="M5.8 13.4a6.7 6.7 0 0 1 2-5.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M16.7 6.8a6.7 6.7 0 0 1 1.5 8.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" opacity=".62" />
      <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r=".55" fill="currentColor" />
    </svg>
  );
}
