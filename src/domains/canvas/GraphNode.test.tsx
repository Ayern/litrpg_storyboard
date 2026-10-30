import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from 'reactflow';

import type { ChapterTask } from '../narrative/types';
import { GraphNode } from './GraphNode';
import type { ChapterCastBadge, NodeData } from './types';

// A chapter card is now a workbench: the scene, its roster, its checklist and a
// quick XP award are all written on the face of the card. Every one of those
// writes leaves through a prop, so the card renders on its own — no board, no
// database, no story load — and these tests hold it to the writes it makes.

const mira: { id: string; name: string } = { id: 'c-1', name: 'Mira' };
const rook: { id: string; name: string } = { id: 'c-2', name: 'Rook' };

const cast: ChapterCastBadge[] = [
  { characterId: 'c-1', name: 'Mira', level: 3, levelIsPenalty: false, skills: [] },
  { characterId: 'c-2', name: 'Rook', level: 4, levelIsPenalty: false, skills: [] },
];

function task(
  id: string,
  text: string,
  position: number,
  done = false
): ChapterTask {
  return {
    id,
    chapter_id: 'n-1',
    text,
    done,
    position,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const objectives = [
  task('t-1', 'Rook reaches the Court', 0),
  task('t-2', 'Vane names his price', 1, true),
];

function renderNode(data: Partial<NodeData> = {}) {
  const props = {
    id: 'n-1',
    type: 'default',
    selected: false,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    zIndex: 0,
    dragging: false,
    targetPosition: 'left',
    sourcePosition: 'right',
    data: {
      label: 'The Ashen Gate',
      nodeType: 'chapter',
      createdBy: 'Ada',
      chapterSeq: 1,
      content: 'The debt comes due in a room where every flame remembers.',
      chapterPov: 'c-1',
      chapterCast: cast,
      castChoices: [mira, rook],
      chapterSkills: {
        'c-1': [
          { id: 's-1', name: 'Ember Whisper', rank: 'Rank 1' },
          { id: 's-2', name: 'Ash Step', rank: 'Rank 3' },
        ],
        'c-2': [{ id: 's-3', name: 'Cinder Step', rank: null }],
      },
      chapterTasks: objectives,
      ...data,
    } as NodeData,
  };

  return render(
    <ReactFlowProvider>
      <GraphNode {...(props as any)} />
    </ReactFlowProvider>
  );
}

describe('GraphNode chapter workbench', () => {
  it('reads the scene, its roster and its checklist off the card', () => {
    renderNode();

    expect(
      screen.getByText('The debt comes due in a room where every flame remembers.')
    ).toBeInTheDocument();
    expect(screen.getByText('Rook reaches the Court')).toBeInTheDocument();
    expect(screen.getByText('Vane names his price')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Mira, Level 3/ })
    ).toHaveTextContent('Lv 3');
  });

  it('says what is missing on an empty chapter', () => {
    renderNode({ content: undefined, chapterCast: [], chapterTasks: [] });

    expect(screen.getByText('No scene summary yet')).toBeInTheDocument();
    expect(screen.getByText('Nobody in this scene yet')).toBeInTheDocument();
    expect(
      screen.getByText('Nothing planned yet — add the scene’s first line.')
    ).toBeInTheDocument();
  });

  it('ticks an objective off without moving it', async () => {
    const user = userEvent.setup();
    const onToggleChapterObjective = vi.fn();

    renderNode({ onToggleChapterObjective });

    await user.click(
      screen.getByRole('checkbox', { name: 'Rook reaches the Court — open' })
    );

    expect(onToggleChapterObjective).toHaveBeenCalledWith(objectives[0]);
  });

  it('writes a new objective with Enter and clears the field', async () => {
    const user = userEvent.setup();
    const onAddChapterObjective = vi.fn(async () => true);

    renderNode({ onAddChapterObjective });

    const field = screen.getByRole('textbox', {
      name: 'Add an objective to The Ashen Gate',
    });

    await user.type(field, 'Mira lifts the ember from the toll gate{Enter}');

    expect(onAddChapterObjective).toHaveBeenCalledWith(
      'Mira lifts the ember from the toll gate'
    );
    expect(field).toHaveValue('');
  });

  it('keeps the typed line when the write is refused', async () => {
    const user = userEvent.setup();
    const onAddChapterObjective = vi.fn(async () => false);

    renderNode({ onAddChapterObjective });

    const field = screen.getByRole('textbox', {
      name: 'Add an objective to The Ashen Gate',
    });

    await user.type(field, 'A line the database refuses{Enter}');

    expect(field).toHaveValue('A line the database refuses');
  });

  it('drops an objective from the card', async () => {
    const user = userEvent.setup();
    const onRemoveChapterObjective = vi.fn();

    renderNode({ onRemoveChapterObjective });

    await user.click(
      screen.getByRole('button', {
        name: 'Drop the objective: Vane names his price',
      })
    );

    expect(onRemoveChapterObjective).toHaveBeenCalledWith(objectives[1]);
  });

  it('opens the roster on the card and changes the point of view', async () => {
    const user = userEvent.setup();
    const onSetChapterPov = vi.fn();

    renderNode({ onSetChapterPov });

    const open = screen.getByRole('button', { name: 'Cast' });
    expect(open).toHaveAttribute('aria-expanded', 'false');

    await user.click(open);

    expect(open).toHaveAttribute('aria-expanded', 'true');

    const pov = screen.getByRole('combobox', {
      name: 'Point of view of The Ashen Gate',
    });

    expect(pov).toHaveValue('c-1');

    await user.selectOptions(pov, 'c-2');

    expect(onSetChapterPov).toHaveBeenCalledWith('c-2');
  });

  it('puts a name in the scene, and leaves the point of view alone', async () => {
    const user = userEvent.setup();
    const onAddChapterCast = vi.fn();
    const onRemoveChapterCast = vi.fn();

    renderNode({
      castChoices: [mira, rook, { id: 'c-3', name: 'Vane' }],
      onAddChapterCast,
      onRemoveChapterCast,
    });

    await user.click(screen.getByRole('button', { name: 'Cast' }));

    const povBox = screen.getByRole('checkbox', {
      name: 'Mira present in The Ashen Gate',
    });
    expect(povBox).toBeChecked();
    expect(povBox).toBeDisabled();

    await user.click(
      screen.getByRole('checkbox', { name: 'Vane present in The Ashen Gate' })
    );
    expect(onAddChapterCast).toHaveBeenCalledWith('c-3');

    await user.click(
      screen.getByRole('checkbox', { name: 'Rook present in The Ashen Gate' })
    );
    expect(onRemoveChapterCast).toHaveBeenCalledWith('c-2');
  });

  it('logs XP from the card, defaulting to the point of view', async () => {
    const user = userEvent.setup();
    const onAddChapterEvent = vi.fn(async () => true);

    renderNode({ onAddChapterEvent });

    await user.click(screen.getByRole('button', { name: '+ Event' }));

    expect(
      screen.getByRole('combobox', { name: 'Who the event happens to in The Ashen Gate' })
    ).toHaveValue('c-1');

    await user.type(
      screen.getByRole('spinbutton', { name: 'XP to award in The Ashen Gate' }),
      '250'
    );
    await user.type(
      screen.getByRole('textbox', {
        name: 'Why the XP was awarded in The Ashen Gate',
      }),
      'Paid for a name at the toll gate'
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAddChapterEvent).toHaveBeenCalledWith(
      'c-1',
      'xp_award',
      'Paid for a name at the toll gate',
      250,
      null,
      true,
      true
    );
    expect(
      screen.queryByRole('button', { name: 'Save' })
    ).not.toBeInTheDocument();
  });

  it('logs a learned skill and an acquired item with their own fields', async () => {
    const user = userEvent.setup();
    const onAddChapterEvent = vi.fn(async () => true);

    renderNode({ onAddChapterEvent });

    await user.click(screen.getByRole('button', { name: '+ Event' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Event type in The Ashen Gate' }),
      'skill_learn'
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Detail of the event in The Ashen Gate' }),
      'Ember Whisper'
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAddChapterEvent).toHaveBeenCalledWith(
      'c-1',
      'skill_learn',
      'Ember Whisper',
      null,
      null,
      true,
      true
    );

    await user.click(screen.getByRole('button', { name: '+ Event' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Event type in The Ashen Gate' }),
      'item_acquire'
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Detail of the event in The Ashen Gate' }),
      'Stolen Ember'
    );
    await user.clear(
      screen.getByRole('spinbutton', { name: 'Quantity in The Ashen Gate' })
    );
    await user.type(
      screen.getByRole('spinbutton', { name: 'Quantity in The Ashen Gate' }),
      '2'
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAddChapterEvent).toHaveBeenCalledWith(
      'c-1',
      'item_acquire',
      'Stolen Ember',
      2,
      null,
      true,
      true
    );
  });

  it('will not log an event without its detail line', async () => {
    const user = userEvent.setup();
    const onAddChapterEvent = vi.fn(async () => true);

    renderNode({ onAddChapterEvent });

    await user.click(screen.getByRole('button', { name: '+ Event' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Event type in The Ashen Gate' }),
      'skill_learn'
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAddChapterEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Add a detail line.');
  });

  it('raises the skill the form names, with no detail line to write', async () => {
    const user = userEvent.setup();
    const onAddChapterEvent = vi.fn(async () => true);

    renderNode({ onAddChapterEvent });

    await user.click(screen.getByRole('button', { name: '+ Event' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Event type in The Ashen Gate' }),
      'skill_rank_up'
    );

    const skill = screen.getByRole('combobox', {
      name: 'Skill the event changes in The Ashen Gate',
    });
    expect(skill).toHaveValue('s-1');
    expect(skill).toHaveTextContent('Ember Whisper (Rank 1)');

    await user.selectOptions(skill, 's-2');
    expect(
      screen.getByText('Ash Step rises from Rank 3.')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAddChapterEvent).toHaveBeenCalledWith(
      'c-1',
      'skill_rank_up',
      '',
      null,
      's-2',
      true,
      true
    );
  });

  it('evolves into a named skill and can retire the base', async () => {
    const user = userEvent.setup();
    const onAddChapterEvent = vi.fn(async () => true);

    renderNode({ onAddChapterEvent });

    await user.click(screen.getByRole('button', { name: '+ Event' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Event type in The Ashen Gate' }),
      'skill_evolve'
    );
    await user.selectOptions(
      screen.getByRole('combobox', {
        name: 'Skill the event changes in The Ashen Gate',
      }),
      's-2'
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Detail of the event in The Ashen Gate' }),
      'Cinder Step'
    );

    const keepBase = screen.getByRole('checkbox', {
      name: 'Keep the base skill in The Ashen Gate',
    });
    expect(keepBase).toBeChecked();
    await user.click(keepBase);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAddChapterEvent).toHaveBeenCalledWith(
      'c-1',
      'skill_evolve',
      'Cinder Step',
      null,
      's-2',
      false,
      true
    );
  });

  it('sacrifices a skill as a record, or takes it off the sheet', async () => {
    const user = userEvent.setup();
    const onAddChapterEvent = vi.fn(async () => true);

    renderNode({ onAddChapterEvent });

    await user.click(screen.getByRole('button', { name: '+ Event' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Event type in The Ashen Gate' }),
      'skill_sacrifice'
    );

    const keepRecord = screen.getByRole('checkbox', {
      name: 'Keep the sacrificed skill in The Ashen Gate',
    });
    expect(keepRecord).toBeChecked();
    await user.click(keepRecord);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAddChapterEvent).toHaveBeenCalledWith(
      'c-1',
      'skill_sacrifice',
      '',
      null,
      's-1',
      true,
      false
    );
  });

  it('says so when the scene has nobody with a skill to change', async () => {
    const user = userEvent.setup();
    const onAddChapterEvent = vi.fn(async () => true);

    renderNode({ onAddChapterEvent, chapterSkills: {} });

    await user.click(screen.getByRole('button', { name: '+ Event' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Event type in The Ashen Gate' }),
      'skill_sacrifice'
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAddChapterEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a skill.');
  });

  it('renders the scene ledger with an icon and a line per event', () => {
    renderNode({
      chapterEvents: [
        {
          id: 'e-1',
          chapter_id: 'n-1',
          actor_id: 'c-2',
          actorName: 'Rook',
          event_type: 'xp_award',
          details: 'Paid for a name at the toll gate',
          amount: 250,
          source_id: 'a-1',
          position: 0,
          created_by: 'Ada',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'e-2',
          chapter_id: 'n-1',
          actor_id: 'c-1',
          actorName: 'Mira',
          event_type: 'skill_learn',
          details: 'Ember Whisper',
          amount: null,
          source_id: 's-1',
          position: 1,
          created_by: 'Ada',
          created_at: '2026-01-01T00:01:00Z',
          updated_at: '2026-01-01T00:01:00Z',
        },
        {
          id: 'e-3',
          chapter_id: 'n-1',
          actor_id: 'c-2',
          actorName: 'Rook',
          event_type: 'skill_sacrifice',
          details: 'Burned a favour to the Court',
          amount: null,
          source_id: null,
          position: 2,
          created_by: 'Ada',
          created_at: '2026-01-01T00:02:00Z',
          updated_at: '2026-01-01T00:02:00Z',
        },
      ],
    });

    const ledger = screen.getByRole('group', {
      name: 'Progression and events in The Ashen Gate',
    });

    expect(ledger).toHaveTextContent('Rook');
    expect(ledger).toHaveTextContent('+250 XP');
    expect(ledger).toHaveTextContent('Paid for a name at the toll gate');
    expect(ledger).toHaveTextContent('Mira');
    expect(ledger).toHaveTextContent('learns Ember Whisper');
    expect(ledger).toHaveTextContent('Burned a favour to the Court');
    expect(ledger).toHaveTextContent('⚡');
    expect(ledger).toHaveTextContent('🔥');
    expect(ledger).toHaveTextContent('💀');
  });

  it('mirrors the skills a sheet records here, without offering to remove them', () => {
    renderNode({
      chapterSheetSkills: [
        {
          skillId: 's-3',
          characterId: 'c-2',
          actorName: 'Rook',
          name: 'Cinder Step',
          rank: null,
        },
        {
          skillId: 's-2',
          characterId: 'c-1',
          actorName: 'Mira',
          name: 'Ash Step',
          rank: 'Rank 3',
        },
      ],
    });

    const ledger = screen.getByRole('group', {
      name: 'Progression and events in The Ashen Gate',
    });

    expect(ledger).toHaveTextContent('Rook');
    expect(ledger).toHaveTextContent('has Cinder Step');
    expect(ledger).toHaveTextContent('Mira');
    expect(ledger).toHaveTextContent('has Ash Step (Rank 3)');
    expect(within(ledger).getAllByText('sheet')).toHaveLength(2);

    // The sheet is where a skill is changed, so the card has no line to take back.
    expect(
      within(ledger).queryByRole('button', { name: /Remove the event/ })
    ).not.toBeInTheDocument();
    expect(
      within(ledger).getByTitle(/Mira has this skill on their sheet/)
    ).toHaveTextContent('has Ash Step');
  });

  it('does not call the ledger empty while the sheets hold skills here', () => {
    renderNode({
      chapterSheetSkills: [
        {
          skillId: 's-3',
          characterId: 'c-2',
          actorName: 'Rook',
          name: 'Cinder Step',
          rank: null,
        },
      ],
    });

    expect(
      screen.queryByText(/Nothing has happened here yet/)
    ).not.toBeInTheDocument();
  });

  it('names the skill an evolution grew out of', () => {
    renderNode({
      chapterEvents: [
        {
          id: 'e-4',
          chapter_id: 'n-1',
          actor_id: 'c-1',
          actorName: 'Mira',
          event_type: 'skill_evolve',
          details: 'Cinder Secret',
          amount: null,
          source_id: null,
          skill_id: 's-1',
          skillName: 'Ember Whisper',
          position: 0,
          created_by: 'Ada',
          created_at: '2026-01-01T00:03:00Z',
          updated_at: '2026-01-01T00:03:00Z',
        },
      ],
    });

    expect(
      screen.getByRole('group', {
        name: 'Progression and events in The Ashen Gate',
      })
    ).toHaveTextContent('evolves Ember Whisper into Cinder Secret');
  });

  it('removes one event from the card', async () => {
    const user = userEvent.setup();
    const onDeleteChapterEvent = vi.fn();

    renderNode({
      onDeleteChapterEvent,
      chapterEvents: [
        {
          id: 'e-1',
          chapter_id: 'n-1',
          actor_id: 'c-2',
          actorName: 'Rook',
          event_type: 'skill_rank_up',
          details: 'Ash Step → Rank 2',
          amount: null,
          source_id: null,
          position: 0,
          created_by: 'Ada',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    await user.click(
      screen.getByRole('button', { name: 'Remove the event: Ash Step → Rank 2' })
    );

    expect(onDeleteChapterEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e-1', event_type: 'skill_rank_up' })
    );
  });

  it('can be put away with Done, Escape or a press outside', async () => {
    const user = userEvent.setup();

    renderNode();

    await user.click(screen.getByRole('button', { name: 'Cast' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(
      screen.queryByRole('combobox', { name: 'Point of view of The Ashen Gate' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cast' }));
    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('combobox', { name: 'Point of view of The Ashen Gate' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cast' }));
    await user.click(document.body);

    expect(
      screen.queryByRole('combobox', { name: 'Point of view of The Ashen Gate' })
    ).not.toBeInTheDocument();
  });

  it('opens the help bubble outside the zoomed board', async () => {
    renderNode();

    screen.getByRole('button', { name: 'About the cast on a chapter card' }).focus();

    const bubble = await screen.findByRole('tooltip');

    // A fixed bubble inside a scaled node is positioned in the board's own
    // coordinates, which is why it drifted as the board zoomed.
    expect(bubble.parentElement).toBe(document.body);
  });

  it('refuses XP that is not a positive whole number', async () => {
    const user = userEvent.setup();
    const onAddChapterEvent = vi.fn(async () => true);

    renderNode({ onAddChapterEvent });

    await user.click(screen.getByRole('button', { name: '+ Event' }));
    await user.type(
      screen.getByRole('spinbutton', { name: 'XP to award in The Ashen Gate' }),
      '0'
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAddChapterEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A whole number of XP above zero.'
    );
  });

  it('draws a system card as the box a reader meets, with the copy on it', () => {
    renderNode({
      nodeType: 'system',
      label: '[SYSTEM ANNOUNCEMENT]',
      content: 'The Choir Notes You\nThe Salt Choir has taken an interest.',
    });

    // The label and the notes become the box rather than a label with a note
    // under it: one header, one title, one block of body text.
    expect(screen.getAllByText('[SYSTEM ANNOUNCEMENT]')).toHaveLength(1);
    expect(screen.getByText('[SYSTEM ANNOUNCEMENT]')).toHaveClass('system-box-header');
    expect(screen.getByText('The Choir Notes You')).toHaveClass('system-box-title');
    expect(screen.getByText('The Salt Choir has taken an interest.')).toHaveClass(
      'system-box-body'
    );
    expect(screen.getByRole('button', { name: 'Copy System Box' })).toBeInTheDocument();
  });

  it('keeps the workbench off every other kind of card', () => {
    renderNode({ nodeType: 'character' });

    expect(screen.queryByText('Objectives')).not.toBeInTheDocument();
    expect(screen.queryByText(/Progression/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cast' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Event' })).not.toBeInTheDocument();
  });
});
