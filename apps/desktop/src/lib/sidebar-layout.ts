export const COLLAPSED_RAIL_WIDTH = 52;
export const MIN_RAIL_WIDTH = 248;
export const MAX_RAIL_WIDTH = 400;
export const DEFAULT_RAIL_WIDTH = 288;

export function clampRailWidth(width: number, maximum = MAX_RAIL_WIDTH): number {
  return Number.isFinite(width)
    ? Math.min(maximum, Math.max(MIN_RAIL_WIDTH, width))
    : DEFAULT_RAIL_WIDTH;
}

export function sessionAge(when?: string, now = Date.now()): string {
  if (!when) return "";
  const time = Date.parse(when.replace(" ", "T"));
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
