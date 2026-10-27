import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ChapterNode } from '../narrative/chapters';
import type { ProgressionChartSeries } from '../progression/types';
import { CharacterSheetPanel } from './CharacterSheetPanel';
import type { CharacterSheetPanelProps } from './CharacterSheetPanel';

// The power curve's empty states are how the sheet tells an author what is
// missing and where to record it: no chapters to place a point on, no
// progression at all, or nothing for the metric that is plotted. They are copy
// rather than state, so the panel is rendered directly with the props the app
// passes and the words are asserted, without a board or a story load.

function chapter(id: string, label: string, seq: number): ChapterNode {
  return {
    id,
    type: 'chapter',
    position: { x: 0, y: 0 },
    data: { label, nodeType: 'chapter', createdBy: 'author', chapterSeq: seq },
  };
}

function series(name: string): ProgressionChartSeries {
  return {
    characterId: 'c-1',
    name,
    color: '#8b5cf6',
    milestones: [],
    progress: [],
  };
}

const oneChapter = [chapter('ch-1', 'One', 1)];

function baseProps(
  chapterNodes: ChapterNode[],
  overrides: Partial<CharacterSheetPanelProps> = {}
): CharacterSheetPanelProps {
  return {
    story: {
      id: 's-1',
      title: 'The Vault',
      description: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    onViewChange: vi.fn(),
    characterError: null,
    chapterNodes,
    chartMetric: 'level',
    setChartMetric: vi.fn(),
    chartStatName: '',
    setChartStatName: vi.fn(),
    statNameOptions: [],
    chartSeries: [],
    chartMetricSeries: [],
    visibleChartSeries: [],
    chartMilestoneSeries: [],
    hiddenChartCharacterIds: [],
    toggleChartCharacter: vi.fn(),
    chartStateChapterId: '',
    setChartStateChapterId: vi.fn(),
    chartStateChapters: [],
    chartStateChapter: null,
    chartStateLoading: false,
    chartStateError: null,
    chartStateById: new Map(),
    visibleComparisonSeries: [],
    characters: [],
    selectedCharacterId: null,
    setSelectedCharacterId: vi.fn(),
    newCharacterName: '',
    setNewCharacterName: vi.fn(),
    newCharacterDescription: '',
    setNewCharacterDescription: vi.fn(),
    createCharacter: vi.fn(async () => {}),
    selectedCharacter: null,
    editingCharacter: false,
    setEditingCharacter: vi.fn(),
    characterNameDraft: '',
    setCharacterNameDraft: vi.fn(),
    characterDescriptionDraft: '',
    setCharacterDescriptionDraft: vi.fn(),
    saveCharacter: vi.fn(async () => {}),
    startCharacterEdit: vi.fn(),
    confirmDeleteCharacter: false,
    setConfirmDeleteCharacter: vi.fn(),
    removeCharacter: vi.fn(async () => {}),
    children: null,
    ...overrides,
  };
}

describe('the power curve empty states', () => {
  it('asks for a chapter before it can plot anything', () => {
    render(<CharacterSheetPanel {...baseProps([])} />);

    expect(
      screen.getByText('Add a chapter before plotting a power curve.')
    ).toBeInTheDocument();
  });

  it('asks for a milestone or some XP once there are chapters', () => {
    render(<CharacterSheetPanel {...baseProps(oneChapter)} />);

    expect(
      screen.getByText(
        "No progression recorded yet — add a level milestone or XP earned on a character's sheet."
      )
    ).toBeInTheDocument();
  });

  it('names what the plotted metric is still missing', () => {
    // Someone on the cast has a row recorded, just nothing the chosen metric can
    // draw: that is the only way past the two empty states above.
    const recorded = { chartSeries: [series('Mira')] };
    const { rerender } = render(
      <CharacterSheetPanel
        {...baseProps(oneChapter, { chartMetric: 'level', ...recorded })}
      />
    );

    expect(
      screen.getByText(
        "No level milestones yet — record one on a character's sheet."
      )
    ).toBeInTheDocument();

    rerender(
      <CharacterSheetPanel {...baseProps(oneChapter, { chartMetric: 'xp', ...recorded })} />
    );
    expect(
      screen.getByText(
        "No XP recorded on a level milestone yet — add total XP on a character's sheet."
      )
    ).toBeInTheDocument();

    rerender(
      <CharacterSheetPanel
        {...baseProps(oneChapter, { chartMetric: 'earned', ...recorded })}
      />
    );
    expect(
      screen.getByText(
        "No XP earned by chapter yet — record it on a character's sheet."
      )
    ).toBeInTheDocument();

    // A stat line can only be drawn against a named stat: one that exists on a
    // sheet is asked for by name, and none at all sends the author to a sheet.
    rerender(
      <CharacterSheetPanel
        {...baseProps(oneChapter, {
          ...recorded,
          chartMetric: 'stat',
          chartStatName: 'Aura',
          statNameOptions: ['Aura'],
        })}
      />
    );
    expect(
      screen.getByText(
        'No Aura snapshots yet — record one on a level milestone.'
      )
    ).toBeInTheDocument();

    rerender(
      <CharacterSheetPanel
        {...baseProps(oneChapter, {
          ...recorded,
          chartMetric: 'stat',
          statNameOptions: [],
        })}
      />
    );
    expect(
      screen.getByText(
        "No numeric stats yet — add a stat on a character's sheet first."
      )
    ).toBeInTheDocument();
  });

  it('asks for a character when every line is hidden', () => {
    render(
      <CharacterSheetPanel
        {...baseProps(oneChapter, {
          chartSeries: [series('Mira')],
          chartMetricSeries: [series('Mira')],
          visibleChartSeries: [],
          hiddenChartCharacterIds: ['c-1'],
        })}
      />
    );

    expect(
      screen.getByText('Choose a character above to show a level line.')
    ).toBeInTheDocument();
  });
});
