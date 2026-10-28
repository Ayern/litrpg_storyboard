// A stat's name is the author's own word, typed in two places: the sheet's rows
// and the value a level-up records. "Strength", "strength" and " strength " are
// the one stat, so the continuity check compares them without case or extra
// spaces rather than claiming the sheet lost a stat it plainly still has.

/** A stat name as it is compared: trimmed, single-spaced and lower-cased. */
export function statKey(name: string) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The sheet's row for a stat name. An exact spelling wins, so a sheet that
 * really does hold both "Strength" and "strength" is read by the row that
 * matches, and only then does the loose comparison pick up the near one.
 */
export function findSheetStat<T extends { stat_name: string }>(
  stats: readonly T[],
  name: string
): T | undefined {
  const key = statKey(name);
  return (
    stats.find(stat => stat.stat_name === name) ??
    stats.find(stat => statKey(stat.stat_name) === key)
  );
}

/** How many single-letter edits turn one name into the other. */
function editDistance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }

    previous = current;
  }

  return previous[b.length];
}

/**
 * A row on the sheet that is probably the recorded stat under another name: an
 * abbreviation ("STR" for "Strength", "Strength" for "Strength (base)") or a
 * typo. It is only ever offered as a hint — two names being one stat is the
 * author's call, so nothing is merged or written on this guess.
 */
export function likelyRenamedStat(
  stats: readonly { stat_name: string }[],
  name: string
): string | null {
  const key = statKey(name);
  if (!key) return null;

  const candidate = stats.find(stat => {
    const other = statKey(stat.stat_name);
    if (!other || other === key) return false;

    const [shorter, longer] =
      other.length <= key.length ? [other, key] : [key, other];

    return (
      (shorter.length >= 3 && longer.startsWith(shorter)) ||
      (shorter.length >= 4 && editDistance(other, key) <= 2)
    );
  });

  return candidate ? candidate.stat_name : null;
}
