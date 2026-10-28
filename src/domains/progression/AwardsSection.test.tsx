import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ChapterNode } from '../narrative/chapters';
import type { CharacterAward } from '../shared/types';
import { AwardsSection } from './AwardsSection';

const stamp = (minute: number) => `2026-10-22T12:${String(minute).padStart(2, '0')}:00Z`;

function chapter(id: string, label: string, seq = 1): ChapterNode {
  return {
    id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: {
      label,
      nodeType: 'chapter',
      createdBy: 'author',
      chapterSeq: seq,
    },
  };
}

function award(overrides: Partial<CharacterAward> = {}): CharacterAward {
  return {
    id: 'a-1',
    character_id: 'char-1',
    chapter_id: 'n1',
    kind: 'xp',
    stat_name: null,
    amount: 250,
    note: 'Paid for a name at the gate.',
    created_by: 'Ada',
    created_at: stamp(0),
    updated_at: stamp(0),
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof AwardsSection>[0]> = {}) {
  return {
    awards: [] as CharacterAward[],
    chapters: [chapter('n1', 'Chapter One'), chapter('n2', 'Chapter Two', 2)],
    statNameOptions: ['Strength', 'Insight'],
    onAdd: vi.fn(async () => true),
    onDelete: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('the awards list', () => {
  it('says what an award is when there are none', () => {
    render(<AwardsSection {...baseProps()} />);

    expect(
      screen.getByText('No awards yet — an event can pay XP or a stat point without a level-up.')
    ).toBeInTheDocument();
  });

  it('names the chapter and amount each award was for', () => {
    render(
      <AwardsSection
        {...baseProps({
          awards: [
            award(),
            award({
              id: 'a-2',
              chapter_id: 'n2',
              kind: 'stat',
              stat_name: 'Insight',
              amount: 1,
              note: null,
            }),
            award({ id: 'a-3', chapter_id: null, kind: 'stat', stat_name: 'Strength', amount: -1 }),
          ],
        })}
      />
    );

    const xp = screen.getByText('+250 XP').closest('.award-row') as HTMLElement;
    expect(within(xp).getByText('Chapter One')).toBeInTheDocument();
    expect(within(xp).getByText('Paid for a name at the gate.')).toBeInTheDocument();

    const insight = screen.getByText('Insight +1').closest('.award-row') as HTMLElement;
    expect(within(insight).getByText('Chapter Two')).toBeInTheDocument();

    const lost = screen.getByText('Strength -1').closest('.award-row') as HTMLElement;
    expect(within(lost).getByText('No chapter')).toBeInTheDocument();
  });

  it('hands the form’s values over as typed and clears the amount after a save', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn(async () => true);
    render(<AwardsSection {...baseProps({ onAdd })} />);

    await user.selectOptions(screen.getByLabelText('Award kind'), 'stat');
    await user.selectOptions(screen.getByLabelText('Award chapter'), 'n2');
    await user.selectOptions(screen.getByLabelText('Award stat'), 'Insight');
    await user.type(screen.getByLabelText('Award amount'), '1');
    await user.type(screen.getByLabelText('Award note'), 'A hidden quest.');
    await user.click(screen.getByRole('button', { name: 'Add award' }));

    expect(onAdd).toHaveBeenCalledWith({
      kind: 'stat',
      chapterId: 'n2',
      statName: 'Insight',
      amount: '1',
      note: 'A hidden quest.',
    });
    expect(screen.getByLabelText('Award amount')).toHaveValue(null);
    expect(screen.getByLabelText('Award note')).toHaveValue('');
  });

  it('asks for a stat only when the award is a stat point', async () => {
    const user = userEvent.setup();
    render(<AwardsSection {...baseProps()} />);

    expect(screen.queryByLabelText('Award stat')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Award kind'), 'stat');
    expect(screen.getByLabelText('Award stat')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Award kind'), 'xp');
    expect(screen.queryByLabelText('Award stat')).not.toBeInTheDocument();
  });

  it('deletes the award a row names', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {});
    const row = award();
    render(<AwardsSection {...baseProps({ awards: [row], onDelete })} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onDelete).toHaveBeenCalledWith(row);
  });
});
