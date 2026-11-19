import type { GitBlameLine } from '../git/blame';

const oldColor = [160, 94, 91, 0.18] as const;
const middleColor = [101, 117, 132, 0.22] as const;
const recentColor = [35, 153, 89, 0.38] as const;
const shadeCount = 9;

export function blameBackgrounds(
  lines: readonly Pick<GitBlameLine, 'authorTime' | 'uncommitted'>[],
): ReadonlyMap<number, string> {
  const times = new Set<number>();
  let oldest = Infinity;
  let newest = -Infinity;
  for (const { authorTime, uncommitted } of lines) {
    if (uncommitted || !Number.isFinite(authorTime) || authorTime === 0) continue;
    times.add(authorTime);
    oldest = Math.min(oldest, authorTime);
    newest = Math.max(newest, authorTime);
  }
  const shades = new Map<number, string>();
  for (const time of times) {
    const position = newest === oldest ? 0.5 : (time - oldest) / (newest - oldest);
    const bucket = Math.round(position * (shadeCount - 1)) / (shadeCount - 1);
    const start = bucket <= 0.5 ? oldColor : middleColor;
    const end = bucket <= 0.5 ? middleColor : recentColor;
    const mix = bucket <= 0.5 ? bucket * 2 : (bucket - 0.5) * 2;
    const channel = (index: 0 | 1 | 2 | 3): number => start[index] + (end[index] - start[index]) * mix;
    const color = ([0, 1, 2] as const).map((index) => Math.round(channel(index)));
    shades.set(time, `rgba(${color.join(', ')}, ${channel(3).toFixed(2)})`);
  }
  return shades;
}
