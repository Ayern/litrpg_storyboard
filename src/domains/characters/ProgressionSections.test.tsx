import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { ChapterNode } from '../narrative/chapters';
import type { CharacterProgress } from '../shared/types';
import { ProgressionSections } from './ProgressionSections';
import type { ProgressionSectionsProps } from './ProgressionSections';

// The ledger keeps one amount per character per chapter, so the add form is the
// one place an author can ask for something the database will refuse. It answers
// where they are: the entry the chapter already has opens for editing, and the
// sheet says why, instead of a write that fails at the top of the page.

function chapter(id: string, label: string, seq: number): ChapterNode {
  return {
    id,
    type: 'chapter',
    position: { x: 0, y: 0 },
    data: { label, nodeType: 'chapter', createdBy: 'author', chapterSeq: seq },
  };
}

function entry(chapterId: string, xp: number): CharacterProgress {
  return {
    id: `xp-${chapterId}`,
    character_id: 'c-1',
    chapter_id: chapterId,
    xp_earned: xp,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const chapters = [chapter('ch-1', 'The Ashen Gate', 1), chapter('ch-2', 'A Ledger of Cinders', 2)];

function baseProps(
  overrides: Partial<ProgressionSectionsProps> = {}
): ProgressionSectionsProps {
  return {
    character: null,
    characterId: 'c-1',
    shownLevel: 2,
    shownXp: 1000,
    shownTarget: 1400,
    progressPercent: 71,
    chapters,
    milestones: [],
    xpEntries: [entry('ch-1', 250)],
    skillEvents: [],
    skills: [],
    growthRules: [],
    growthPoints: [],
    awards: [],
    stats: [],
    onStatWritten: vi.fn(),
    onPlacePoint: vi.fn(async () => {}),
    actor: 'author',
    statNameOptions: [],
    focus: null,
    onError: vi.fn(),
    onSaveProgress: vi.fn(async () => true),
    onSaveGrowth: vi.fn(async () => true),
    onDeleteGrowth: vi.fn(async () => {}),
    onAddAward: vi.fn(async () => true),
    onDeleteAward: vi.fn(async () => {}),
    onCreateXpEntry: vi.fn(async () => true),
    onSaveXpEntry: vi.fn(async () => true),
    onDeleteXpEntry: vi.fn(async () => true),
    ...overrides,
  };
}

function chooseChapter(label: string) {
  fireEvent.change(screen.getByLabelText('New XP entry chapter'), {
    target: { value: chapters.find(choice => choice.data.label === label)!.id },
  });
}

function typeXp(value: string) {
  fireEvent.change(screen.getByLabelText('New XP entry earned XP'), {
    target: { value },
  });
}

describe('the XP by chapter form', () => {
  it('opens the entry a chapter already has instead of recording a second one', () => {
    const props = baseProps();

    render(<ProgressionSections {...props} />);

    chooseChapter('The Ashen Gate');
    typeXp('1000');
    fireEvent.click(screen.getByRole('button', { name: 'Add XP' }));

    expect(props.onCreateXpEntry).not.toHaveBeenCalled();
    expect(props.onError).toHaveBeenCalledWith(
      'The Ashen Gate already has XP recorded for this character — edit that entry to change it.'
    );

    // The row is open for editing, holding what the chapter paid out, so the
    // author can change the number they meant to change.
    expect(screen.getByLabelText('XP entry earned XP')).toHaveValue(250);
    expect(screen.getByRole('button', { name: 'Save XP' })).toBeInTheDocument();

    // The form they typed in is empty again, so it cannot be sent a second time.
    expect(screen.getByLabelText('New XP entry chapter')).toHaveValue('');
    expect(screen.getByLabelText('New XP entry earned XP')).toHaveValue(null);
  });

  it('records the XP of a chapter that has none yet', () => {
    const props = baseProps();

    render(<ProgressionSections {...props} />);

    chooseChapter('A Ledger of Cinders');
    typeXp('900');
    fireEvent.click(screen.getByRole('button', { name: 'Add XP' }));

    expect(props.onCreateXpEntry).toHaveBeenCalledWith({
      chapterId: 'ch-2',
      xp: '900',
    });
    expect(props.onError).not.toHaveBeenCalled();
  });
});
