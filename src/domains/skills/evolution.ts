import type { SkillEvolution } from '../shared/types';

// How each evolution step is drawn. Colour and line shape carry the meaning so
// the tree reads without the legend; anything unrecognised stays neutral rather
// than vanishing.
export const EVOLUTION_STYLES: Record<
  string,
  { label: string; color: string; dash?: string; width: number }
> = {
  upgrade: { label: 'Upgrade', color: '#5b8def', width: 2 },
  fusion: { label: 'Fusion', color: '#e0af68', width: 2.6 },
  mutation: { label: 'Mutation', color: '#bb9af7', dash: '6 4', width: 2 },
  branch: { label: 'Branch', color: '#6dd3c7', dash: '2 5', width: 1.8 },
};

export function evolutionStyle(type: string) {
  return EVOLUTION_STYLES[type.trim().toLowerCase()] ?? {
    label: type,
    color: '#9aa4b2',
    dash: '4 3',
    width: 1.6,
  };
}

// The shortest chain of links from one skill to another, as the ids to walk, or
// null when there is no way through. A new link would close a loop exactly when
// its child can already be walked back to its parent, so the chain it would join
// is what the form names before the write is refused.
export function evolutionPath(
  evolutions: Pick<SkillEvolution, 'parent_skill_id' | 'child_skill_id'>[],
  fromId: string,
  toId: string
): string[] | null {
  const children = new Map<string, string[]>();

  for (const evolution of evolutions) {
    children.set(evolution.parent_skill_id, [
      ...(children.get(evolution.parent_skill_id) ?? []),
      evolution.child_skill_id,
    ]);
  }

  const seen = new Set([fromId]);
  const queue: string[][] = [[fromId]];

  while (queue.length > 0) {
    const path = queue.shift() as string[];
    const last = path[path.length - 1];

    for (const next of children.get(last) ?? []) {
      if (next === toId) return [...path, next];
      if (seen.has(next)) continue;

      seen.add(next);
      queue.push([...path, next]);
    }
  }

  return null;
}
