import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Character, FactionStanding } from '../shared/types';
import type { Story } from '../stories/types';
import { CharacterRelationsView, CharacterSkillsView } from './CharacterViews';

// The two diagram views say what is missing rather than drawing an empty frame,
// and they narrow the faction cards to the labels the map resolves. Both are
// rendered directly with the props the app passes, so the words and the mapping
// are asserted without a board or a story load.

const story: Story = {
  id: 's-1',
  title: 'The Vault',
  description: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function character(id: string, name: string): Character {
  return {
    id,
    story_id: 's-1',
    name,
    description: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function factionNode(id: string, label: string) {
  return {
    id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: { label, nodeType: 'faction' as const, createdBy: 'author' },
  };
}

const standing: FactionStanding = {
  id: 'st-1',
  story_id: 's-1',
  character_id: 'c-1',
  faction_node_id: 'f-1',
  standing: 'Sworn',
  since_chapter_id: null,
  until_chapter_id: null,
  note: null,
  created_by: 'you',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const noop = () => {};

describe('the Characters tab diagrams', () => {
  it('asks for a story instead of drawing an empty relations map', () => {
    render(
      <CharacterRelationsView
        story={null}
        onViewChange={noop}
        characters={[]}
        relations={[]}
        standings={[]}
        factionCards={[]}
        onOpenRelation={noop}
        onOpenStanding={noop}
      />
    );

    expect(screen.getByText('Load a story to map its cast')).toBeInTheDocument();
    expect(screen.queryByLabelText('Cast relations map')).not.toBeInTheDocument();
  });

  it('asks for a story instead of drawing an empty skill tree', () => {
    render(
      <CharacterSkillsView
        story={null}
        onViewChange={noop}
        skills={[]}
        characters={[]}
        evolutions={[]}
        chapterNodes={[]}
        error={null}
        onCreate={async () => true}
        onDelete={async () => {}}
        onOpenSkill={noop}
      />
    );

    expect(
      screen.getByText('Load a story to see how its skills evolved')
    ).toBeInTheDocument();
  });

  it('names the faction a standing belongs to from the card it was handed', () => {
    render(
      <CharacterRelationsView
        story={story}
        onViewChange={noop}
        characters={[character('c-1', 'Rook')]}
        relations={[]}
        standings={[standing]}
        factionCards={[factionNode('f-1', 'The Ember Guild')]}
        onOpenRelation={noop}
        onOpenStanding={noop}
      />
    );

    expect(screen.getByLabelText('Cast relations map')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: "Edit Rook's Sworn standing in The Ember Guild",
      })
    ).toBeInTheDocument();
  });

  it('reports the view the toggle switches to', async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();

    render(
      <CharacterSkillsView
        story={null}
        onViewChange={onViewChange}
        skills={[]}
        characters={[]}
        evolutions={[]}
        chapterNodes={[]}
        error={null}
        onCreate={async () => true}
        onDelete={async () => {}}
        onOpenSkill={noop}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Sheets' }));

    expect(onViewChange).toHaveBeenCalledWith('sheet');
  });
});
