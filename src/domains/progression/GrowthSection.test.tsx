import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { LevelGrowthRule, LevelGrowthStat } from '../shared/types';
import { GrowthSection } from './GrowthSection';

const stamp = (minute: number) => `2026-10-22T12:${String(minute).padStart(2, '0')}:00Z`;

function rate(statName: string, perLevel: number): LevelGrowthStat {
  return {
    id: `rate-${statName}`,
    rule_id: 'rule',
    stat_name: statName,
    per_level: perLevel,
    created_at: stamp(0),
    updated_at: stamp(0),
  };
}

function rule(
  id: string,
  characterId: string | null,
  points: number,
  stats: LevelGrowthStat[] = []
): LevelGrowthRule {
  return {
    id,
    story_id: 'story-1',
    character_id: characterId,
    points_per_level: points,
    xp_base: 100,
    xp_growth: 0,
    stats,
    created_by: 'Ada',
    created_at: stamp(0),
    updated_at: stamp(0),
  };
}

function baseProps(overrides: Partial<Parameters<typeof GrowthSection>[0]> = {}) {
  return {
    storyRule: null as LevelGrowthRule | null,
    characterRule: null as LevelGrowthRule | null,
    statNameOptions: ['Strength', 'Agility'],
    onSave: vi.fn(async () => true),
    onDelete: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('the level growth section', () => {
  it('says when there is no rule and when a character follows the story’s', () => {
    render(<GrowthSection {...baseProps()} />);

    expect(
      screen.getByText('Not set — a level hands out nothing until you say what it should.')
    ).toBeInTheDocument();
    expect(screen.getByText('Follows the story rule.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set rule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Override' })).toBeInTheDocument();
  });

  it('reads the rule a level hands out', () => {
    render(
      <GrowthSection
        {...baseProps({
          storyRule: rule('rule-story', null, 3, [rate('Strength', 1)]),
          characterRule: rule('rule-rook', 'char-1', 1),
        })}
      />
    );

    expect(
      screen.getByText('100 XP a level · 3 points to place per level · Strength +1')
    ).toBeInTheDocument();
    expect(
      screen.getByText('100 XP a level · 1 point to place per level')
    ).toBeInTheDocument();
  });

  it('saves the story rule with the points and rates that were typed', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => true);
    render(<GrowthSection {...baseProps({ onSave })} />);

    await user.click(screen.getByRole('button', { name: 'Set rule' }));
    const points = screen.getByLabelText('Growth points per level');
    await user.clear(points);
    await user.type(points, '2');

    await user.click(screen.getByRole('button', { name: 'Add rate' }));
    await user.selectOptions(screen.getByLabelText('Growth rate 1 stat'), 'Agility');
    await user.type(screen.getByLabelText('Growth rate 1 per level'), '1');

    await user.click(screen.getByRole('button', { name: 'Save rule' }));

    expect(onSave).toHaveBeenCalledWith('story', '2', '100', '0', [
      { statName: 'Agility', perLevel: '1' },
    ]);
    expect(screen.queryByLabelText('Growth points per level')).not.toBeInTheDocument();
  });

  it('opens an override with the story rule’s numbers already in it', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => true);
    render(
      <GrowthSection
        {...baseProps({
          storyRule: rule('rule-story', null, 3, [rate('Strength', 1)]),
          onSave,
        })}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Override' }));

    expect(screen.getByLabelText('Growth points per level')).toHaveValue(3);
    expect(screen.getByLabelText('Growth rate 1 stat')).toHaveValue('Strength');
    expect(screen.getByLabelText('Growth rate 1 per level')).toHaveValue(1);

    await user.clear(screen.getByLabelText('Growth points per level'));
    await user.type(screen.getByLabelText('Growth points per level'), '1');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));

    // The override starts from the story's rule but is saved for the character,
    // so the numbers are the story's until the author changes them.
    expect(onSave).toHaveBeenCalledWith('character', '1', '100', '0', [
      { statName: 'Strength', perLevel: '1' },
    ]);
  });

  it('removes an override and puts the character back on the story rule', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {});
    const characterRule = rule('rule-rook', 'char-1', 1);
    render(
      <GrowthSection
        {...baseProps({ characterRule, onDelete })}
      />
    );

    const characterRow = screen.getByText('This character').closest('.growth-row') as HTMLElement;
    await user.click(within(characterRow).getByRole('button', { name: 'Remove' }));

    expect(onDelete).toHaveBeenCalledWith(characterRule);
  });

  it('leaves the editor open when the save is refused', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => false);
    render(<GrowthSection {...baseProps({ onSave })} />);

    await user.click(screen.getByRole('button', { name: 'Set rule' }));
    await user.click(screen.getByRole('button', { name: 'Save rule' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Growth points per level')).toBeInTheDocument();
  });
});
