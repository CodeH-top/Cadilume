import type { PlexItem } from "./types";

export interface ContextPlaybackSelection {
  current: PlexItem;
  queue: PlexItem[];
}

/**
 * Pick a random track while keeping playback strictly inside the supplied
 * album or playlist context.
 */
export function selectRandomContextPlayback(
  context: readonly PlexItem[],
  rng: () => number = Math.random,
): ContextPlaybackSelection | null {
  const queue = context.filter((item) => item.type === "track");
  if (queue.length === 0) return null;

  const sampledIndex = Math.floor(rng() * queue.length);
  const currentIndex = Number.isNaN(sampledIndex)
    ? 0
    : Math.min(queue.length - 1, Math.max(0, sampledIndex));

  return {
    current: queue[currentIndex],
    queue,
  };
}
