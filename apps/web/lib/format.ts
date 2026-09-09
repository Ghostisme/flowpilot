export function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined) return "—";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

export function formatClock(iso?: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatJson(value: unknown): string {
  if (value === undefined) return "No data emitted yet.";
  return JSON.stringify(value, null, 2);
}

export function shortId(value?: string): string {
  if (!value) return "—";
  return value.length > 20 ? `${value.slice(0, 11)}…${value.slice(-5)}` : value;
}
