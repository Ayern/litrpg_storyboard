import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ChapterCastBadge, NodeData } from '../canvas/types';
import type { ChapterContinuityFlag, ChapterNote, Character } from '../shared/types';
import { ChapterCastPanel } from './ChapterCastPanel';
import type { ChapterCastPanelProps } from './ChapterCastPanel';
import { ChapterNotesPanel } from './ChapterNotesPanel';
import type { ChapterNotesPanelProps } from './ChapterNotesPanel';
import { ChaptersPanel } from './ChaptersPanel';
import type { ChaptersPanelProps } from './ChaptersPanel';
import type { ChapterNode } from './chapters';

// These three panels are pure views: every answer they show arrives as a prop
// and every write leaves through one, so they render with no board, no database
// and no story load. That is the property these tests hold them to — rendered
// directly, with the props the app passes, and asserting the writes rather than
// the state behind them.

function chapter(id: string, label: string, data: Partial<NodeData> = {}): ChapterNode {
  return {
    id,
    type: 'chapter',
    position: { x: 0, y: 0 },
    data: { label, nodeType: 'chapter', createdBy: 'author', ...data },
  };
}

const mira: Character = {
  id: 'c-1',
  story_id: 's-1',
  name: 'Mira',
  description: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const rook: Character = { ...mira, id: 'c-2', name: 'Rook' };

const note = (id: string, chapterId: string, text: string): ChapterNote => ({
  id,
  chapterId,
  text,
});

// An XP warning the panel can act on: the ledger's total can go onto the
// milestone in one click, and its two named parts open where each one lives.
const xpFlag: ChapterContinuityFlag = {
  id: 'flag-1',
  kind: 'xp-income-mismatch',
  chapterId: 'ch-1',
  characterId: 'c-1',
  characterName: 'Mira',
  summary: 'Mira has 2,000 XP but the chapters add up to 1,200',
  detail: 'The ledger through One adds up to 1,200, and the milestone says 2,000.',
  parts: [
    'The ledger through ',
    { id: 'ch-1', text: 'One', kind: 'chapter' },
    ' gives ',
    {
      id: 'c-1',
      text: 'Mira',
      kind: 'character',
      target: { kind: 'level', milestoneId: 'm-1' },
    },
    ' 1,200 XP, but the milestone says 2,000',
  ],
  ledgerXp: 1200,
  target: { kind: 'level', milestoneId: 'm-1' },
};

function baseProps(overrides: Partial<ChaptersPanelProps> = {}): ChaptersPanelProps {
  return {
    story: {
      id: 's-1',
      title: 'The Vault',
      description: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    renderSearchPalette: () => (
      <div data-testid="chapter-search-palette">Search every card</div>
    ),
    searchShortcut: 'Ctrl+K',
    openSearch: vi.fn(),
    chapterNodes: [
      chapter('ch-1', 'One', { chapterSeq: 1, chapterWords: 500 }),
      chapter('ch-2', 'Two', { chapterSeq: 2 }),
    ],
    chapterIssues: { duplicates: [], missing: [], unnumbered: 0 },
    chapterTotals: { words: 500, target: null, targeted: 0 },
    chapterWordsPercent: 0,
    chapterTimeline: [],
    chapterError: null,
    chapterBusy: false,
    newChapterTitle: '',
    setNewChapterTitle: vi.fn(),
    addChapter: vi.fn(async () => {}),
    saveChapterOrder: vi.fn(async () => {}),
    revealedChapterId: null,
    characters: [],
    castNames: new Map<string, string>(),
    chapterCastByChapter: new Map<string, ChapterCastBadge[]>(),
    chapterCastIsExplicit: () => false,
    setChapterCastPresence: vi.fn(async () => {}),
    chapterCastBusyId: null,
    chapterCastError: null,
    openChapterCastId: null,
    toggleChapterCastPanel: vi.fn(),
    editingChapterId: null,
    openChapterDetails: vi.fn(() => true),
    chapterArcInputRef: { current: null },
    chapterArcDraft: '',
    setChapterArcDraft: vi.fn(),
    chapterWordsDraft: '',
    setChapterWordsDraft: vi.fn(),
    chapterTargetDraft: '',
    setChapterTargetDraft: vi.fn(),
    chapterPovDraft: '',
    setChapterPovDraft: vi.fn(),
    chapterDayDraft: '',
    setChapterDayDraft: vi.fn(),
    chapterTimeDraft: '',
    setChapterTimeDraft: vi.fn(),
    saveChapterDetails: vi.fn(async () => {}),
    requestChapterClose: vi.fn(),
    chapterFormPrompt: null,
    dismissChapterPrompt: vi.fn(),
    discardChapterEdit: vi.fn(),
    closeChapterForm: vi.fn(),
    leaveChapterForm: vi.fn(),
    chapterKeepEditingRef: { current: null },
    notesByChapter: new Map<string, ChapterNote[]>(),
    noteCount: () => 0,
    openNotesChapterId: null,
    toggleChapterNotes: vi.fn(),
    notePrompt: null,
    dismissNotePrompt: vi.fn(),
    discardNoteDraft: vi.fn(),
    noteKeepEditingRef: { current: null },
    noteEditorRef: { current: null },
    noteAddRef: { current: null },
    editingNoteId: null,
    matchedNoteId: null,
    noteEditDraft: '',
    setNoteEditDraft: vi.fn(),
    noteDraft: '',
    setNoteDraft: vi.fn(),
    noteBusy: false,
    noteError: null,
    startNoteEdit: vi.fn(),
    requestNoteEditCancel: vi.fn(),
    saveNoteEdit: vi.fn(async () => {}),
    deleteNote: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    continuityLines: [],
    openCharacterSheet: vi.fn(),
    revealChapter: vi.fn(),
    syncingXpMilestoneId: null,
    syncMilestoneXp: vi.fn(async () => {}),
    syncingStatKey: null,
    syncSheetStat: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('ChaptersPanel', () => {
  it('says to load a story, and draws nothing of its own', () => {
    render(<ChaptersPanel {...baseProps({ story: null })} />);

    expect(
      screen.getByText('Load a story to put its chapters in order')
    ).toBeInTheDocument();

    // No header, no search box and no palette: the tab has nothing to order.
    expect(
      screen.queryByRole('heading', { name: 'Reading order' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Search' })
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('chapter-search-palette')).not.toBeInTheDocument();
  });

  it('opens the search palette from its own button, in place', async () => {
    const user = userEvent.setup();
    const renderSearchPalette = vi.fn((placement: 'inline') => (
      <div data-testid="chapter-search-palette">{placement}</div>
    ));
    const openSearch = vi.fn();

    render(<ChaptersPanel {...baseProps({ renderSearchPalette, openSearch })} />);

    // The palette is drawn inside the tab rather than over the board.
    expect(renderSearchPalette).toHaveBeenCalledWith('inline');
    expect(screen.getByTestId('chapter-search-palette')).toHaveTextContent('inline');

    const search = screen.getByRole('button', { name: 'Search' });
    expect(search).toHaveAttribute(
      'title',
      'Find a card, a cast member, a connection, a note or a story (Ctrl+K)'
    );

    await user.click(search);

    expect(openSearch).toHaveBeenCalledTimes(1);
  });

  it('says there are no chapters yet, and keeps the list and the timeline away', () => {
    render(<ChaptersPanel {...baseProps({ chapterNodes: [], chapterTimeline: [] })} />);

    expect(
      screen.getByText(
        'No chapters yet — add one here, or add a chapter card on the Graph tab.'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Chapters' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Chapter timeline' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('lists each chapter in the order it was handed, with its number and its words', () => {
    render(
      <ChaptersPanel
        {...baseProps({
          chapterNodes: [
            chapter('ch-1', 'One', {
              chapterSeq: 1,
              chapterWords: 500,
              chapterTarget: 2000,
              chapterArc: 'The Vault',
            }),
            chapter('ch-2', 'Two', { chapterSeq: 2 }),
          ],
        })}
      />
    );

    const rows = within(
      screen.getByRole('list', { name: 'Chapters' })
    ).getAllByRole('listitem');

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('One');
    expect(rows[0]).toHaveTextContent('The Vault');
    expect(rows[0]).toHaveTextContent('500 / 2,000 words');
    expect(rows[1]).toHaveTextContent('Two');
    expect(rows[1]).toHaveTextContent('No word count');
  });

  it('reports a chapter that has no position rather than hiding it', () => {
    render(
      <ChaptersPanel
        {...baseProps({
          chapterNodes: [chapter('ch-1', 'One', { chapterSeq: 1 }), chapter('ch-9', 'Later')],
          chapterIssues: { duplicates: [], missing: [], unnumbered: 1 },
        })}
      />
    );

    expect(
      screen.getByText(
        'The reading order needs attention: 1 chapter has no position.'
      )
    ).toBeInTheDocument();
  });

  it('moves a chapter with its arrows through the one ordered write', async () => {
    const user = userEvent.setup();
    const saveChapterOrder = vi.fn(async () => {});

    render(<ChaptersPanel {...baseProps({ saveChapterOrder })} />);

    // The ends of the list have nowhere further to go.
    expect(screen.getByRole('button', { name: 'Move One earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Two later' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Move One later' }));

    // The order it came from rides along, so one undo puts the list back.
    expect(saveChapterOrder).toHaveBeenCalledTimes(1);
    expect(saveChapterOrder).toHaveBeenCalledWith(
      ['ch-2', 'ch-1'],
      ['ch-1', 'ch-2']
    );
  });

  it('renumbers what is shown, with nothing to come back to', async () => {
    const user = userEvent.setup();
    const saveChapterOrder = vi.fn(async () => {});

    render(
      <ChaptersPanel
        {...baseProps({
          saveChapterOrder,
          chapterIssues: { duplicates: [2], missing: [], unnumbered: 0 },
        })}
      />
    );

    expect(
      screen.getByText(
        'The reading order needs attention: position 2 is used more than once.'
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Renumber' }));

    // No previous order: numbering what is shown is the whole point of it.
    expect(saveChapterOrder).toHaveBeenCalledWith(['ch-1', 'ch-2'], null);
  });

  it('leaves the numbering warning away when the numbers are in order', () => {
    render(<ChaptersPanel {...baseProps()} />);

    expect(
      screen.queryByRole('button', { name: 'Renumber' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/The reading order needs attention/)
    ).not.toBeInTheDocument();
  });

  it('toggles a row’s cast and notes, and counts what is already there', async () => {
    const user = userEvent.setup();
    const toggleChapterCastPanel = vi.fn();
    const toggleChapterNotes = vi.fn();

    render(
      <ChaptersPanel
        {...baseProps({
          toggleChapterCastPanel,
          toggleChapterNotes,
          noteCount: (chapterId: string) => (chapterId === 'ch-1' ? 2 : 0),
          chapterCastByChapter: new Map([
            ['ch-1', [{ characterId: 'c-1', name: 'Mira', level: 3, levelIsPenalty: false, skills: [] }]],
          ]),
        })}
      />
    );

    expect(screen.getByRole('button', { name: 'Notes for One' })).toHaveTextContent(
      'Notes (2)'
    );
    expect(screen.getByRole('button', { name: 'Cast for One' })).toHaveTextContent(
      'Cast (1)'
    );
    expect(screen.getByRole('button', { name: 'Cast for Two' })).toHaveTextContent(
      'Cast'
    );

    await user.click(screen.getByRole('button', { name: 'Cast for One' }));
    await user.click(screen.getByRole('button', { name: 'Notes for One' }));

    expect(toggleChapterCastPanel).toHaveBeenCalledWith('ch-1');
    expect(toggleChapterNotes).toHaveBeenCalledWith('ch-1');
  });

  it('mounts the cast checklist and the notes for the row that opened them only', () => {
    render(
      <ChaptersPanel
        {...baseProps({
          openChapterCastId: 'ch-1',
          openNotesChapterId: 'ch-1',
          characters: [mira, rook],
          chapterCastIsExplicit: (chapterId: string, characterId: string) =>
            chapterId === 'ch-1' && characterId === 'c-1',
        })}
      />
    );

    const cast = screen.getByRole('group', { name: 'Cast present in One' });
    expect(within(cast).getByRole('checkbox', { name: 'Mira present in One' })).toBeChecked();
    expect(within(cast).getByRole('checkbox', { name: 'Rook present in One' })).not.toBeChecked();

    expect(screen.getByRole('textbox', { name: 'New note for One' })).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Cast present in Two' })
    ).not.toBeInTheDocument();
  });

  it('shows the details form for the chapter being edited and writes from it', async () => {
    const user = userEvent.setup();
    const setChapterArcDraft = vi.fn();
    const saveChapterDetails = vi.fn(async () => {});
    const requestChapterClose = vi.fn();

    render(
      <ChaptersPanel
        {...baseProps({
          editingChapterId: 'ch-1',
          chapterArcDraft: 'The Vault',
          setChapterArcDraft,
          saveChapterDetails,
          requestChapterClose,
        })}
      />
    );

    const arc = screen.getByLabelText('Arc');
    expect(arc).toHaveValue('The Vault');

    await user.type(arc, 's');
    expect(setChapterArcDraft).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(saveChapterDetails).toHaveBeenCalledTimes(1);
    expect(requestChapterClose).toHaveBeenCalledTimes(1);
  });

  it('adds up the story and says how full its target is', () => {
    render(
      <ChaptersPanel
        {...baseProps({
          chapterTotals: { words: 1200, target: 2000, targeted: 1 },
          chapterWordsPercent: 60,
        })}
      />
    );

    expect(screen.getByText(/1,200 words of 2,000/)).toBeInTheDocument();
    expect(screen.getByText(/2 chapters · 1 with a target/)).toBeInTheDocument();

    const bar = screen.getByRole('progressbar', { name: 'Story word count' });
    expect(bar).toHaveAttribute('aria-valuenow', '60');
  });

  it('leaves the target bar away when no chapter has a target, and counts one chapter as one', () => {
    render(
      <ChaptersPanel
        {...baseProps({
          chapterNodes: [chapter('ch-1', 'One', { chapterSeq: 1, chapterWords: 1 })],
          chapterTotals: { words: 1, target: null, targeted: 0 },
        })}
      />
    );

    expect(screen.getByText('1 word')).toBeInTheDocument();
    expect(screen.getByText('1 chapter')).toBeInTheDocument();
    expect(screen.queryByText(/with a target/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('names the timeline and counts the chapters left off it', () => {
    render(
      <ChaptersPanel
        {...baseProps({
          chapterNodes: [
            chapter('ch-1', 'One', { chapterSeq: 1, chapterDay: 1, chapterTime: 'Dusk' }),
            chapter('ch-2', 'Two', { chapterSeq: 2, chapterDay: 2 }),
            chapter('ch-3', 'Three', { chapterSeq: 3 }),
          ],
          chapterTimeline: [
            chapter('ch-2', 'Two', { chapterSeq: 2, chapterDay: 2 }),
            chapter('ch-1', 'One', { chapterSeq: 1, chapterDay: 1, chapterTime: 'Dusk' }),
          ],
        })}
      />
    );

    const placed = within(
      screen.getByRole('list', { name: 'Chapter timeline' })
    ).getAllByRole('listitem');

    expect(placed).toHaveLength(2);
    expect(placed[0]).toHaveTextContent('Day 2');
    expect(placed[0]).toHaveTextContent('#2');
    expect(placed[1]).toHaveTextContent('Day 1');
    expect(placed[1]).toHaveTextContent('Dusk');
    expect(screen.getByText(/2 placed · 1 without a day/)).toBeInTheDocument();
  });

  it('points every continuity line at what it names, and syncs the ledger', async () => {
    const user = userEvent.setup();
    const openCharacterSheet = vi.fn();
    const revealChapter = vi.fn();
    const syncMilestoneXp = vi.fn(async () => {});

    render(
      <ChaptersPanel
        {...baseProps({
          continuityLines: [{ parts: xpFlag.parts, flag: xpFlag }],
          openCharacterSheet,
          revealChapter,
          syncMilestoneXp,
        })}
      />
    );

    expect(screen.getByRole('heading', { name: 'Continuity' })).toBeInTheDocument();
    expect(screen.getByText(/1 to check · advisory/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mira' }));
    await user.click(screen.getByRole('button', { name: 'One' }));

    expect(openCharacterSheet).toHaveBeenCalledWith('c-1', {
      kind: 'level',
      milestoneId: 'm-1',
    });
    expect(revealChapter).toHaveBeenCalledWith('ch-1');

    await user.click(screen.getByRole('button', { name: 'Sync to 1,200 XP' }));

    expect(syncMilestoneXp).toHaveBeenCalledWith(xpFlag);
  });

  it('puts a level-up’s stat value on the sheet in one click, and holds while it writes', async () => {
    const user = userEvent.setup();
    const syncSheetStat = vi.fn(async () => {});
    const statFlag: ChapterContinuityFlag = {
      ...xpFlag,
      id: 'flag-stat',
      kind: 'stat-sheet-mismatch',
      summary: "Mira's Strength is 9, ledger says 12",
      detail: "Mira's Strength is 9 on the sheet, but the level-up in One recorded 12.",
      statName: 'Strength',
      statValue: 12,
      ledgerXp: undefined,
    };
    const lines = [{ parts: statFlag.parts, flag: statFlag }];

    const { rerender } = render(
      <ChaptersPanel {...baseProps({ continuityLines: lines, syncSheetStat })} />
    );

    await user.click(screen.getByRole('button', { name: 'Set to 12' }));

    expect(syncSheetStat).toHaveBeenCalledWith(statFlag);

    rerender(
      <ChaptersPanel
        {...baseProps({
          continuityLines: lines,
          syncSheetStat,
          syncingStatKey: 'c-1::Strength',
        })}
      />
    );

    expect(screen.getByRole('button', { name: 'Syncing…' })).toBeDisabled();
  });

  it('holds the sync button while its own write is in flight', () => {
    render(
      <ChaptersPanel
        {...baseProps({
          continuityLines: [{ parts: xpFlag.parts, flag: xpFlag }],
          syncingXpMilestoneId: 'm-1',
        })}
      />
    );

    expect(screen.getByRole('button', { name: 'Syncing…' })).toBeDisabled();
  });

  it('shows a refused chapter write above the list', () => {
    render(
      <ChaptersPanel
        {...baseProps({ chapterError: 'The chapter could not be saved' })}
      />
    );

    expect(screen.getByText('The chapter could not be saved')).toHaveClass('audit-error');
  });
});

function castProps(overrides: Partial<ChapterCastPanelProps> = {}): ChapterCastPanelProps {
  return {
    chapterId: 'ch-1',
    chapterLabel: 'One',
    linkedId: null,
    povId: null,
    characters: [],
    chapterCastIsExplicit: () => false,
    setChapterCastPresence: vi.fn(async () => {}),
    busy: false,
    chapterCastError: null,
    ...overrides,
  };
}

describe('ChapterCastPanel', () => {
  it('asks for a cast member when the story has none', () => {
    render(<ChapterCastPanel {...castProps()} />);

    expect(
      screen.getByText('Add a cast member on the Characters tab first.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('ticks a character in, tagging the linked cast member and the point of view', async () => {
    const user = userEvent.setup();
    const setChapterCastPresence = vi.fn(async () => {});

    render(
      <ChapterCastPanel
        {...castProps({
          characters: [mira, rook],
          linkedId: 'c-1',
          povId: 'c-2',
          chapterCastIsExplicit: (_chapterId: string, characterId: string) =>
            characterId === 'c-1',
          setChapterCastPresence,
        })}
      />
    );

    const panel = screen.getByRole('group', { name: 'Cast present in One' });
    const rows = within(panel).getAllByRole('listitem');

    expect(rows[0]).toHaveTextContent('Mira');
    expect(rows[0]).toHaveTextContent('Linked');
    expect(rows[0]).not.toHaveTextContent('POV');
    expect(rows[1]).toHaveTextContent('Rook');
    expect(rows[1]).toHaveTextContent('POV');
    expect(rows[1]).not.toHaveTextContent('Linked');

    await user.click(within(panel).getByRole('checkbox', { name: 'Rook present in One' }));

    expect(setChapterCastPresence).toHaveBeenCalledWith('ch-1', 'c-2', true);
  });

  it('disables every box while a cast write is in flight, and shows a refusal', () => {
    render(
      <ChapterCastPanel
        {...castProps({
          characters: [mira, rook],
          busy: true,
          chapterCastError: 'That character is in the trash',
        })}
      />
    );

    expect(
      screen.getByRole('checkbox', { name: 'Mira present in One' })
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Rook present in One' })
    ).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That character is in the trash'
    );
  });
});

function notesProps(overrides: Partial<ChapterNotesPanelProps> = {}): ChapterNotesPanelProps {
  return {
    chapterLabel: 'One',
    notes: [],
    notePrompt: null,
    dismissNotePrompt: vi.fn(),
    discardNoteDraft: vi.fn(),
    noteKeepEditingRef: { current: null },
    noteEditorRef: { current: null },
    noteAddRef: { current: null },
    editingNoteId: null,
    matchedNoteId: null,
    noteEditDraft: '',
    setNoteEditDraft: vi.fn(),
    noteDraft: '',
    setNoteDraft: vi.fn(),
    noteBusy: false,
    noteError: null,
    startNoteEdit: vi.fn(),
    requestNoteEditCancel: vi.fn(),
    saveNoteEdit: vi.fn(async () => {}),
    deleteNote: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    ...overrides,
  };
}

// The row a note is drawn in, so a class the panel puts on it can be read
// without reaching into the container.
function noteRow(text: string): Element {
  const row = screen.getByText(text).closest('.chapter-note');
  if (!row) throw new Error(`no note row around “${text}”`);
  return row;
}

describe('ChapterNotesPanel', () => {
  const first = note('n-1', 'ch-1', 'Mira finds the vault door');
  const second = note('n-2', 'ch-1', 'Rook is already inside');

  it('says a note is plain text when there is none, and keeps the box that adds one', () => {
    render(<ChapterNotesPanel {...notesProps()} />);

    expect(
      screen.getByText('No notes yet — a note is plain text, kept with the chapter.')
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'New note for One' })).toBeInTheDocument();
  });

  it('adds a note, and will not add an empty one', async () => {
    const user = userEvent.setup();
    const addNote = vi.fn(async () => {});

    const { unmount } = render(<ChapterNotesPanel {...notesProps({ addNote })} />);
    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled();
    unmount();

    render(
      <ChapterNotesPanel {...notesProps({ addNote, noteDraft: 'A line to keep' })} />
    );

    await user.click(screen.getByRole('button', { name: 'Add note' }));
    expect(addNote).toHaveBeenCalledTimes(1);

    // Ctrl+Enter is the same write without leaving the box.
    await user.click(screen.getByRole('textbox', { name: 'New note for One' }));
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(addNote).toHaveBeenCalledTimes(2);
  });

  it('edits a note in place, saving with the button or Ctrl+Enter and leaving with Escape', async () => {
    const user = userEvent.setup();
    const setNoteEditDraft = vi.fn();
    const saveNoteEdit = vi.fn(async () => {});
    const requestNoteEditCancel = vi.fn();

    render(
      <ChapterNotesPanel
        {...notesProps({
          notes: [first, second],
          editingNoteId: 'n-1',
          noteEditDraft: 'Mira finds the vault door',
          setNoteEditDraft,
          saveNoteEdit,
          requestNoteEditCancel,
        })}
      />
    );

    const editor = screen.getByRole('textbox', { name: 'Edit note in One' });
    expect(editor).toHaveValue('Mira finds the vault door');

    await user.type(editor, '!');
    expect(setNoteEditDraft).toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(requestNoteEditCancel).toHaveBeenCalledTimes(1);

    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(saveNoteEdit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveNoteEdit).toHaveBeenCalledTimes(2);
  });

  it('marks the note a search hit points at, and deletes one through its row', async () => {
    const user = userEvent.setup();
    const deleteNote = vi.fn(async () => {});

    render(
      <ChapterNotesPanel
        {...notesProps({ notes: [first, second], matchedNoteId: 'n-2', deleteNote })}
      />
    );

    expect(noteRow('Mira finds the vault door')).not.toHaveClass('matched');
    expect(noteRow('Rook is already inside')).toHaveClass('matched');

    await user.click(
      screen.getByRole('button', { name: 'Delete the note Rook is already inside' })
    );

    expect(deleteNote).toHaveBeenCalledWith(second);
  });

  it('asks before an edited note is dropped', async () => {
    const user = userEvent.setup();
    const discardNoteDraft = vi.fn();
    const dismissNotePrompt = vi.fn();

    render(
      <ChapterNotesPanel
        {...notesProps({
          notes: [first],
          editingNoteId: 'n-1',
          noteEditDraft: 'Mira finds',
          notePrompt: { message: 'Open “Two” and drop this note?', go: () => {} },
          discardNoteDraft,
          dismissNotePrompt,
        })}
      />
    );

    const prompt = screen.getByRole('alertdialog', { name: 'Unsaved note changes' });
    expect(prompt).toHaveTextContent('Open “Two” and drop this note?');

    await user.click(
      within(prompt).getByRole('button', { name: 'Discard and continue' })
    );
    expect(discardNoteDraft).toHaveBeenCalledTimes(1);

    await user.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
    expect(dismissNotePrompt).toHaveBeenCalledTimes(1);
  });

  it('dismisses the question with Escape from wherever the focus was left', async () => {
    const user = userEvent.setup();
    const dismissNotePrompt = vi.fn();
    const requestNoteEditCancel = vi.fn();

    render(
      <ChapterNotesPanel
        {...notesProps({
          notePrompt: {
            message: 'Close this note and drop the draft?',
            go: () => {},
          },
          dismissNotePrompt,
          requestNoteEditCancel,
        })}
      />
    );

    // Nothing is being edited: the caret is in the new-note box, which has no
    // Escape of its own, so the dismissal is the panel's.
    await user.click(screen.getByRole('textbox', { name: 'New note for One' }));
    await user.keyboard('{Escape}');

    expect(dismissNotePrompt).toHaveBeenCalledTimes(1);
    expect(requestNoteEditCancel).not.toHaveBeenCalled();
  });

  it('shows a refused note write under the list', () => {
    render(
      <ChapterNotesPanel
        {...notesProps({ notes: [first], noteError: 'A note needs some text' })}
      />
    );

    expect(screen.getByText('A note needs some text')).toHaveClass('chapter-note-error');
  });
});
