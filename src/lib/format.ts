// Plain digits with thousands separators, so a story total reads at a glance.
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

// A recorded moment in the reader's own locale and time zone. An unparseable
// stamp is shown as it was recorded rather than as "Invalid Date".
export function formatWhen(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}
