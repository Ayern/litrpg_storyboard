import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('pays XP into the chapter from the card', async () => {
    const user = userEvent.setup();
    const onQuickAward = vi.fn(async () => true);

    renderNode({ onQuickAward });

    await user.click(screen.getByRole('button', { name: '+ XP' }));

    expect(
      screen.getByRole('combobox', { name: 'Who the XP is for in The Ashen Gate' })
    ).toHaveValue('c-1');

    await user.type(
      screen.getByRole('spinbutton', { name: 'XP to award in The Ashen Gate' }),
      '250'
    );
    await user.click(screen.getByRole('button', { name: 'Award' }));

    expect(onQuickAward).toHaveBeenCalledWith('c-1', 250);
    expect(
      screen.queryByRole('button', { name: 'Award' })
    ).not.toBeInTheDocument();
  });

  it('refuses an award that is not a positive whole number', async () => {
    const user = userEvent.setup();
    const onQuickAward = vi.fn(async () => true);

    renderNode({ onQuickAward });

    await user.click(screen.getByRole('button', { name: '+ XP' }));
    await user.type(
      screen.getByRole('spinbutton', { name: 'XP to award in The Ashen Gate' }),
      '0'
    );
    await user.click(screen.getByRole('button', { name: 'Award' }));

    expect(onQuickAward).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A whole number above zero.'
    );
  });

  it('keeps the workbench off every other kind of card', () => {
    renderNode({ nodeType: 'character' });

    expect(screen.queryByText('Objectives')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cast' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ XP' })).not.toBeInTheDocument();
  });
});
