import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { writeText } = vi.hoisted(() => ({ writeText: vi.fn() }));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText }));

import { CopySystemBoxButton, SystemBoxFace } from './SystemBox';
import { systemMessageOf } from './systemMessage';

// The card face and the two copy buttons: what the box looks like for each kind
// of announcement, and what the clipboard is told to take.

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockResolvedValue(undefined);
});

const levelUp = [
  'Type: level_up',
  'Title: The Tide Advances',
  'Level: 3 → 4',
  'Points: 2',
  'Stat: Agility | 12 → 13',
].join('\n');

describe('the box on the card', () => {
  it('draws a level-up with its level, its points and its stat rows', () => {
    render(<SystemBoxFace message={systemMessageOf('The Tidal Ledger', levelUp)} />);

    expect(screen.getByText('Level 3 → 4')).toHaveClass('system-box-level');
    expect(screen.getByText('2 points to place')).toHaveClass('system-box-points');
    expect(screen.getByText('Agility: 12 → 13')).toBeInTheDocument();
    expect(screen.getByText('+1')).toHaveClass('system-box-delta');
  });

  it('gives a level that hands out one point a singular', () => {
    const message = {
      ...systemMessageOf('Level Up', levelUp),
      points: '1',
    };

    render(<SystemBoxFace message={message} />);

    expect(screen.getByText('1 point to place')).toBeInTheDocument();
  });

  it('draws a quest with its banner, ticks and rewards', () => {
    render(
      <SystemBoxFace
        message={systemMessageOf(
          '[QUEST]',
          [
            'Type: quest',
            'Title: The Drowned Stair',
            'Status: accepted',
            'Objective: [x] Reach the Drowned Stair',
            'Objective: [ ] Retrieve the Bell Clapper',
            'Reward: 400 XP',
            'Reward: +10 Faction Standing',
          ].join('\n')
        )}
      />
    );

    expect(screen.getByText('QUEST ACCEPTED')).toHaveClass('system-box-status');
    expect(screen.getByText('Reach the Drowned Stair').closest('li')).toHaveClass('done');
    expect(screen.getByText('Retrieve the Bell Clapper').closest('li')).not.toHaveClass('done');
    expect(screen.getByText('Rewards: 400 XP · +10 Faction Standing')).toHaveClass(
      'system-box-rewards'
    );
  });

  it('draws a skill with its rank and what it grew out of', () => {
    render(
      <SystemBoxFace
        message={systemMessageOf(
          '[SKILL]',
          [
            'Type: skill',
            'Title: [Ember Step]',
            'Rank: 2 (Evolved)',
            'Evolution: Evolved from [Spark Step] via Deep Water immersion',
          ].join('\n')
        )}
      />
    );

    expect(screen.getByText('Rank 2 (Evolved)')).toHaveClass('system-box-rank');
    expect(
      screen.getByText('Evolved from [Spark Step] via Deep Water immersion')
    ).toHaveClass('system-box-evolution');
  });

  it('draws an achievement with its banner and reward', () => {
    render(
      <SystemBoxFace
        message={systemMessageOf(
          '[ACHIEVEMENT]',
          ['Type: achievement', 'Title: First Blood', 'Reward: +1 Feat point'].join('\n')
        )}
      />
    );

    expect(screen.getByText('ACHIEVEMENT UNLOCKED')).toHaveClass('system-box-banner');
    expect(screen.getByText('Rewards: +1 Feat point')).toHaveClass('system-box-rewards');
  });

  it('still draws a card written before the format as a notice', () => {
    render(
      <SystemBoxFace
        message={systemMessageOf(
          '[SYSTEM ANNOUNCEMENT]',
          'The Choir Notes You\nThe Salt Choir has taken an interest.'
        )}
      />
    );

    expect(screen.getByText('[SYSTEM ANNOUNCEMENT]')).toHaveClass('system-box-header');
    expect(screen.getByText('The Choir Notes You')).toHaveClass('system-box-title');
    expect(screen.getByText('The Salt Choir has taken an interest.')).toHaveClass(
      'system-box-body'
    );
  });

  it('says what to write when the box is empty', () => {
    render(<SystemBoxFace message={systemMessageOf('Level Up', null)} />);

    expect(screen.getByText(/Choose what this box announces/)).toBeInTheDocument();
  });

  it('does not call a box with only a level empty', () => {
    render(
      <SystemBoxFace
        message={{
          ...systemMessageOf('Level Up', null),
          kind: 'level_up',
          levelFrom: '3',
          levelTo: '4',
        }}
      />
    );

    expect(screen.getByText('Level 3 → 4')).toBeInTheDocument();
    expect(screen.queryByText(/Choose what this box announces/)).not.toBeInTheDocument();
  });
});

describe('the copy buttons', () => {
  it('copies the box as Markdown and says so', async () => {
    const user = userEvent.setup();
    render(
      <CopySystemBoxButton
        message={systemMessageOf('Level Up', 'Level 4\n+2 to place')}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Copy System Box' }));

    expect(writeText).toHaveBeenCalledWith(
      [
        '> **Level Up**',
        '>',
        '> **Level 4**',
        '>',
        '> +2 to place',
      ].join('\n')
    );
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('copies HTML from its own button and says so', async () => {
    const user = userEvent.setup();
    render(
      <CopySystemBoxButton
        message={systemMessageOf('Level Up', 'Level 4\n+2 to place')}
        format="html"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Copy HTML' }));

    expect(writeText).toHaveBeenCalledWith(
      [
        '<blockquote>',
        '  <p><strong>Level Up</strong></p>',
        '  <p><strong>Level 4</strong></p>',
        '  <p>+2 to place</p>',
        '</blockquote>',
      ].join('\n')
    );
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('does not claim a copy a locked clipboard refused', async () => {
    const user = userEvent.setup();
    writeText.mockRejectedValueOnce('the clipboard is locked');

    render(<CopySystemBoxButton message={systemMessageOf('Level Up', 'Level 4')} />);

    await user.click(screen.getByRole('button', { name: 'Copy System Box' }));

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
  });
});
