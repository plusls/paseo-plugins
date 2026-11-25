function trimZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) {
    return `${trimZero((value / 1_000_000_000).toFixed(1))}B`;
  }
  if (value >= 1_000_000) {
    return `${trimZero((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 1_000) {
    return `${trimZero((value / 1_000).toFixed(1))}k`;
  }
  return String(Math.round(value));
}

export function formatRate(tokens: number, ms: number): string {
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || ms <= 0) {
    return "-";
  }
  const rate = tokens / (ms / 1000);
  if (!Number.isFinite(rate)) return "-";
  return `${rate.toFixed(1)} huk/s`;
}

export function formatPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return "-";
  }
  const ratio = Math.min(1, Math.max(0, part / whole));
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatDayLabel(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}
