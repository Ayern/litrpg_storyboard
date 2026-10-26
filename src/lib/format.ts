// Plain digits with thousands separators, so a story total reads at a glance.
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
