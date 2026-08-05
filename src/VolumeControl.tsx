import { Volume1, Volume2, VolumeX } from "lucide-react";
import type { CSSProperties } from "react";
import { rangeFillPercent } from "./playerUi";

export type VolumeControlVariant = "compact" | "expanded";

export function normalizeVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

export function effectiveVolume(volume: number, muted: boolean): number {
  return muted ? 0 : normalizeVolume(volume);
}

export function volumePercent(volume: number, muted: boolean): number {
  return Math.round(effectiveVolume(volume, muted) * 100);
}

function VolumeIcon({ volume, muted }: { volume: number; muted: boolean }) {
  const effective = effectiveVolume(volume, muted);
  if (effective === 0) return <VolumeX size={18} strokeWidth={1.8} aria-hidden="true" />;
  if (effective < 0.5) return <Volume1 size={18} strokeWidth={1.8} aria-hidden="true" />;
  return <Volume2 size={18} strokeWidth={1.8} aria-hidden="true" />;
}

export function SharedVolumeControl({
  variant,
  volume,
  muted,
  disabled = false,
  onMutedChange,
  onVolumeChange,
}: {
  variant: VolumeControlVariant;
  volume: number;
  muted: boolean;
  disabled?: boolean;
  onMutedChange?: (muted: boolean) => void;
  onVolumeChange?: (volume: number) => void;
}) {
  const effective = effectiveVolume(volume, muted);
  const percent = volumePercent(volume, muted);
  const compact = variant === "compact";
  const containerClass = compact ? "volume-control shared-volume-control" : "now-playing-volume shared-volume-control";
  const buttonClass = compact
    ? `icon-button${muted ? " active" : ""}`
    : `now-playing-control-button${muted ? " is-active" : ""}`;
  const popoverClass = compact ? "volume-popover" : "now-playing-volume-popover";
  const progressProperty = compact ? "--range-progress" : "--now-playing-volume";
  const rangeStyle = { [progressProperty]: `${rangeFillPercent(effective, 1)}%` } as CSSProperties;
  const muteLabel = muted ? "取消静音" : "静音";

  const changeVolume = (next: number) => {
    const normalized = normalizeVolume(next);
    if (muted && normalized > 0) onMutedChange?.(false);
    onVolumeChange?.(normalized);
  };

  return (
    <div className={containerClass} role="group" aria-label="播放器独立音量">
      <button
        className={buttonClass}
        type="button"
        disabled={disabled || !onMutedChange}
        aria-label={muteLabel}
        data-tooltip={muteLabel}
        aria-pressed={muted}
        title={muteLabel}
        onClick={() => onMutedChange?.(!muted)}
      >
        <VolumeIcon volume={volume} muted={muted} />
      </button>
      <div className={popoverClass}>
        <div className="shared-volume-range-wrap">
          <input
            className="shared-volume-range"
            aria-label="播放器独立音量"
            aria-orientation="vertical"
            aria-valuetext={`${percent}%`}
            title={`音量 ${percent}%`}
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={effective}
            disabled={disabled || !onVolumeChange}
            style={rangeStyle}
            onChange={(event) => changeVolume(Number(event.target.value))}
          />
        </div>
        <output aria-live="polite">{percent}%</output>
      </div>
    </div>
  );
}
