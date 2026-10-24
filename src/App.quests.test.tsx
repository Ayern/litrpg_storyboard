import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const { invokeMock, flowMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  flowMock: { setCenter: vi.fn(), getZoom: vi.fn(() => 1) },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

// The canvas, reduced to the parts the app needs to mount a graph.
vi.mock('reactflow', async () => {
  const React = await import('react');

  const PassThrough = ({ children }: { children?: unknown }) =>
    React.createElement('div', null, children as React.ReactNode);

  const Canvas = (props: any) => {
    const { nodes = [], nodeTypes = {}, children, onInit, onNodeClick } = props;
    const Card = nodeTypes.default;

    React.useEffect(() => {
      onInit?.(flowMock);
    }, [onInit]);

    return React.createElement(
      'div',
      { 'data-testid': 'canvas' },
      nodes.map((node: any) =>
        React.createElement(
          'div',
          { key: node.id, className: 'react-flow__node', 'data-id': node.id },
          Card
            ? React.createElement(Card, {
                id: node.id,
                data: node.data,
                isConnectable: true,
                selected: false,
                xPos: 0,
                yPos: 0,
                zIndex: 0,
                dragging: false,
              })
            : null,
          React.createElement(
            'button',
            { key: 'open', onClick: (event: unknown) => onNodeClick?.(event, node) },
            node.data.label
          )
        )
      ),
      children as React.ReactNode
    );
  };

  return {
    default: Canvas,
    Controls: () => null,
    Background: () => null,
    Panel: PassThrough,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    useNodesState: (initial: unknown[]) => {
      const [state, setState] = React.useState(initial);
      return [state, setState, () => {}];
    },
    useEdgesState: (initial: unknown[]) => {
      const [state, setState] = React.useState(initial);
      return [state, setState, () => {}];
    },
  };
});

const story = {
  id: 'story-1',
  title: 'Ledger',
  description: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

const rook = {
  id: 'char-1',
  story_id: story.id,
  name: 'Rook',
  description: null,
  level: 3,
  xp: 250,
  rank: 'Bronze',
  xp_to_next: 1000,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

const mira = {
  ...rook,
  id: 'char-2',
  name: 'Mira',
};

const nodeRow = (id: string, type: string, label: string) => ({
  id,
  story_id: story.id,
  node_type: type,
  label,
  content: null,
  pos_x: 0,
  pos_y: 0,
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  character_id: null,
  chapter_seq: type === 'chapter' ? Number(id.slice(1)) : null,
});

interface RewardRow {
  id: string;
  quest_id: string;
  reward_type: string;
  target_id: string | null;
  amount_or_details: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

interface QuestRow {
  id: string;
  story_id: string;
  title: string;
  giver_character_id: string | null;
  faction_node_id: string | null;
  accepted_chapter_id: string | null;
  completed_chapter_id: string | null;
  status: string;
  description: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  rewards: RewardRow[];
}

interface CastRow {
  id: string;
  chapter_id: string;
  character_id: string;
  created_at: string;
  updated_at: string;
}

let quests: QuestRow[] = [];
let chapterCast: CastRow[] = [];
let progress: any[] = [];
let inventory: any[] = [];

const reward = (
  id: string,
  questId: string,
  type: string,
  target: string | null,
  details: string | null
): RewardRow => ({
  id,
  quest_id: questId,
  reward_type: type,
  target_id: target,
  amount_or_details: details,
  applied_at: null,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
});

const questRow = (overrides: Partial<QuestRow> = {}): QuestRow => ({
  id: 'quest-1',
  story_id: story.id,
  title: 'The Ledger',
  giver_character_id: 'char-1',
  faction_node_id: 'n4',
  accepted_chapter_id: 'n1',
  completed_chapter_id: null,
  status: 'active',
  description: null,
  notes: null,
  created_by: 'Ada',
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  rewards: [],
  ...overrides,
});

beforeEach(() => {
  quests = [];
  chapterCast = [];
  progress = [];
  inventory = [];

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, any>;

    switch (command) {
      case 'get_all_stories':
        return [story];
      case 'get_graph_nodes':
        return [
          nodeRow('n1', 'chapter', 'Chapter One'),
          nodeRow('n2', 'chapter', 'Chapter Two'),
          nodeRow('n3', 'chapter', 'Chapter Three'),
          nodeRow('n4', 'faction', 'The Ashen Guild'),
        ];
      case 'get_graph_edges':
      case 'get_character_stats':
      case 'get_story_character_stats':
      case 'get_character_attributes':
      case 'get_character_skills':
      case 'get_character_inventory':
      case 'get_character_currency':
      case 'get_character_level_milestones':
      case 'get_character_progress':
      case 'get_story_skills':
      case 'get_story_skill_events':
      case 'get_story_level_milestones':
      case 'get_story_relations':
      case 'get_story_faction_standings':
      case 'get_chapter_notes':
      case 'get_story_chapter_cast_states':
        return [];
      case 'get_story_chapter_cast':
        return chapterCast.map(member => ({ ...member }));
      case 'get_characters':
        return [{ ...rook }, { ...mira }];
      case 'get_story_quests':
        return quests.map(quest => ({ ...quest, rewards: quest.rewards.map(r => ({ ...r })) }));
      case 'create_graph_node':
        return {
          id: 'n5',
          story_id: story.id,
          node_type: args.nodeType,
          label: args.label,
          content: null,
          pos_x: args.posX,
          pos_y: args.posY,
          created_by: args.createdBy,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
          character_id: null,
          chapter_seq: null,
        };
      case 'get_story_character_progress':
        return progress.map(row => ({ ...row }));
      case 'get_story_inventory':
        return inventory.map(row => ({ ...row }));
      case 'add_quest': {
        const saved = questRow({
          id: `quest-${quests.length + 1}`,
          title: args.title,
          giver_character_id: args.giverCharacterId ?? null,
          faction_node_id: args.factionNodeId ?? null,
          accepted_chapter_id: args.acceptedChapterId ?? null,
          completed_chapter_id: args.completedChapterId ?? null,
          status: args.status,
          description: args.description ?? null,
          notes: args.notes ?? null,
          rewards: [],
        });
        quests = [...quests, saved];
        return { ...saved, rewards: [] };
      }
      case 'update_quest': {
        const existing = quests.find(quest => quest.id === args.id);
        if (!existing) return null;
        const updated: QuestRow = {
          ...existing,
          title: args.title,
          giver_character_id: args.giverCharacterId ?? null,
          faction_node_id: args.factionNodeId ?? null,
          accepted_chapter_id: args.acceptedChapterId ?? null,
          completed_chapter_id: args.completedChapterId ?? null,
          status: args.status,
          description: args.description ?? null,
          notes: args.notes ?? null,
        };
        quests = quests.map(quest => (quest.id === updated.id ? updated : quest));
        return { ...updated, rewards: updated.rewards.map(r => ({ ...r })) };
      }
      case 'delete_quest':
        quests = quests.filter(quest => quest.id !== args.id);
        return null;
      case 'add_quest_reward': {
        const nextId =
          quests.reduce((count, quest) => count + quest.rewards.length, 0) + 1;
        const saved = reward(
          `reward-${nextId}`,
          args.questId,
          args.rewardType,
          args.targetId ?? null,
          args.amountOrDetails ?? null
        );
        quests = quests.map(quest =>
          quest.id === args.questId
            ? { ...quest, rewards: [...quest.rewards, saved] }
            : quest
        );
        return { ...saved };
      }
      case 'update_quest_reward': {
        let updated: RewardRow | null = null;
        quests = quests.map(quest => ({
          ...quest,
          rewards: quest.rewards.map(row => {
            if (row.id !== args.id) return row;
            updated = {
              ...row,
              reward_type: args.rewardType,
              target_id: args.targetId ?? null,
              amount_or_details: args.amountOrDetails ?? null,
            };
            return updated;
          }),
        }));
        return updated;
      }
      case 'delete_quest_reward':
        quests = quests.map(quest => ({
          ...quest,
          rewards: quest.rewards.filter(row => row.id !== args.id),
        }));
        return null;
      case 'mark_quest_rewards_applied':
        quests = quests.map(quest => ({
          ...quest,
          rewards: quest.rewards.map(row =>
            (args.ids as string[]).includes(row.id)
              ? { ...row, applied_at: '2026-10-22T12:30:00Z' }
              : row
          ),
        }));
        return null;
      case 'update_character_progress': {
        progress = progress.map(row =>
          row.id === args.id
            ? { ...row, chapter_id: args.chapterId, xp_earned: args.xpEarned }
            : row
        );
        return progress.find(row => row.id === args.id);
      }
      case 'add_character_progress': {
        const saved = {
          id: `progress-${progress.length + 1}`,
          character_id: args.characterId,
          chapter_id: args.chapterId,
          xp_earned: args.xpEarned,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        progress = [...progress, saved];
        return saved;
      }
      case 'add_inventory_item': {
        const saved = {
          id: `item-${inventory.length + 1}`,
          character_id: args.characterId,
          name: args.name,
          rarity: args.rarity ?? null,
          quantity: args.quantity,
          effect: args.effect ?? null,
          chapter_id: args.chapterId ?? null,
          lost_chapter_id: null,
          node_id: null,
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        };
        inventory = [...inventory, saved];
        return saved;
      }
      default:
        return null;
    }
  });

  // The cast assigned to a chapter is what the reward-target check compares.
  chapterCast = [];
});

function lastCall(command: string) {
  return [...invokeMock.mock.calls].reverse().find(call => call[0] === command)?.[1];
}

async function openQuests() {
  const user = userEvent.setup();
  render(<App />);

  await screen.findAllByText('Ledger');
  await user.click(screen.getByRole('button', { name: 'Quests' }));

  return user;
}

function questCard(title: string) {
  return screen.getByRole('region', { name: `Quest ${title}` });
}

function continuityText() {
  const panel = screen.getByRole('region', { name: 'Continuity' });
  return [...panel.querySelectorAll('li')].map(item => item.textContent).join('\n');
}

describe('the quest ledger', () => {
  it('records a quest with its giver, faction and two chapters', async () => {
    const user = await openQuests();

    await user.click(screen.getByRole('button', { name: 'New quest' }));
    await user.type(screen.getByLabelText('Quest title'), 'The Ledger');
    await user.selectOptions(screen.getByLabelText('Quest giver'), 'char-1');
    await user.selectOptions(screen.getByLabelText('Quest faction'), 'n4');
    await user.selectOptions(screen.getByLabelText('Quest accepted chapter'), 'n1');
    await user.selectOptions(screen.getByLabelText('Quest completed chapter'), 'n2');
    await user.type(screen.getByLabelText('Quest description'), 'Find the page.');

    // Choosing the ending chapter ends the contract, so the status follows it
    // rather than asking for the same fact twice.
    expect(screen.getByLabelText('Quest status')).toHaveValue('completed');

    // Clearing it reopens the quest, so neither control can contradict the
    // other by accident.
    await user.selectOptions(screen.getByLabelText('Quest completed chapter'), '');
    expect(screen.getByLabelText('Quest status')).toHaveValue('active');

    await user.selectOptions(screen.getByLabelText('Quest completed chapter'), 'n2');
    expect(screen.getByLabelText('Quest status')).toHaveValue('completed');

    await user.click(screen.getByRole('button', { name: 'Save quest' }));

    expect(lastCall('add_quest')).toMatchObject({
      storyId: story.id,
      title: 'The Ledger',
      giverCharacterId: 'char-1',
      factionNodeId: 'n4',
      acceptedChapterId: 'n1',
      completedChapterId: 'n2',
      status: 'completed',
      description: 'Find the page.',
      notes: null,
      user: 'You',
    });

    const card = questCard('The Ledger');
    expect(card).toHaveTextContent('Completed');
    expect(card).toHaveTextContent('Accepted in Chapter One');
    expect(card).toHaveTextContent('Ended in Chapter Two');
    expect(card).toHaveTextContent('Giver: Rook');
    expect(card).toHaveTextContent('Faction: The Ashen Guild');
    expect(card).toHaveTextContent('No rewards recorded');
  });

  it('shows every status at once, not just the word already in the field', async () => {
    const user = await openQuests();
    await user.click(screen.getByRole('button', { name: 'New quest' }));

    const status = screen.getByLabelText('Quest status');
    await user.click(status);

    const options = within(
      screen.getByRole('listbox', { name: 'Quest status suggestions' })
    ).getAllByRole('option');

    expect(options.map(option => option.textContent)).toEqual([
      'active',
      'completed',
      'failed',
      'abandoned',
    ]);

    await user.click(
      within(
        screen.getByRole('listbox', { name: 'Quest status suggestions' })
      ).getByRole('option', { name: 'failed' })
    );

    expect(status).toHaveValue('failed');
  });

  it('makes a faction card from the quest form', async () => {
    const user = await openQuests();
    await user.click(screen.getByRole('button', { name: 'New quest' }));

    await user.type(
      screen.getByLabelText('New quest faction name'),
      'The Silver Chain'
    );
    await user.click(screen.getByRole('button', { name: 'Add faction' }));

    expect(lastCall('create_graph_node')).toMatchObject({
      storyId: story.id,
      nodeType: 'faction',
      label: 'The Silver Chain',
      createdBy: 'You',
    });

    const faction = screen.getByLabelText('Quest faction');
    expect(faction).toHaveValue('n5');
    expect(
      within(faction).getByRole('option', { name: 'The Silver Chain' })
    ).toBeInTheDocument();
  });

  it('puts a badge on both chapters and opens the quest from it', async () => {
    quests = [
      questRow({
        completed_chapter_id: 'n2',
        status: 'completed',
      }),
    ];

    const user = await openQuests();
    await user.click(screen.getByRole('button', { name: 'Graph' }));

    const first = document.querySelector('[data-id="n1"]') as HTMLElement;
    const second = document.querySelector('[data-id="n2"]') as HTMLElement;

    const accepted = within(first).getByRole('button', {
      name: 'The Ledger, completed, accepted here',
    });
    const ended = within(second).getByRole('button', {
      name: 'The Ledger, completed, ended here',
    });

    expect(accepted).toHaveTextContent('The Ledger');
    expect(ended).toHaveTextContent('The Ledger');

    await user.click(accepted);

    expect(screen.getByRole('button', { name: 'Quests' })).toHaveClass('active');
    expect(questCard('The Ledger')).toHaveClass('quest-focused');
  });

  it('narrows the list by status and deletes a quest', async () => {
    quests = [
      questRow(),
      questRow({
        id: 'quest-2',
        title: 'The Toll',
        status: 'failed',
        giver_character_id: null,
        faction_node_id: null,
      }),
    ];

    const user = await openQuests();

    expect(screen.getByText('The Ledger')).toBeInTheDocument();
    expect(screen.getByText('The Toll')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Failed' }));

    expect(screen.queryByText('The Ledger')).not.toBeInTheDocument();
    expect(screen.getByText('The Toll')).toBeInTheDocument();

    await user.click(within(questCard('The Toll')).getByTitle('Delete “The Toll”'));

    expect(lastCall('delete_quest')).toMatchObject({ id: 'quest-2', user: 'You' });
    expect(screen.queryByText('The Toll')).not.toBeInTheDocument();
  });

  it('records, edits and deletes a reward bundle', async () => {
    quests = [questRow({ giver_character_id: null, faction_node_id: null })];

    const user = await openQuests();
    const card = questCard('The Ledger');

    await user.click(within(card).getByRole('button', { name: 'Add reward' }));
    await user.selectOptions(within(card).getByLabelText('Reward type'), 'xp');
    await user.selectOptions(within(card).getByLabelText('Reward target'), 'char-1');
    await user.type(within(card).getByLabelText('Reward amount or details'), '250');
    await user.click(within(card).getByRole('button', { name: 'Save reward' }));

    expect(lastCall('add_quest_reward')).toMatchObject({
      questId: 'quest-1',
      rewardType: 'xp',
      targetId: 'char-1',
      amountOrDetails: '250',
      user: 'You',
    });
    expect(questCard('The Ledger')).toHaveTextContent('XPRook250');

    await user.click(within(questCard('The Ledger')).getByTitle('Change this reward'));
    await user.clear(screen.getByLabelText('Reward amount or details'));
    await user.type(screen.getByLabelText('Reward amount or details'), '300');
    await user.click(screen.getByRole('button', { name: 'Save reward' }));

    expect(lastCall('update_quest_reward')).toMatchObject({
      id: 'reward-1',
      rewardType: 'xp',
      targetId: 'char-1',
      amountOrDetails: '300',
      user: 'You',
    });

    await user.click(within(questCard('The Ledger')).getByTitle('Delete this reward'));
    expect(lastCall('delete_quest_reward')).toMatchObject({
      id: 'reward-1',
      user: 'You',
    });
    expect(questCard('The Ledger')).toHaveTextContent('No rewards recorded');
  });
});

describe('quest continuity', () => {
  it('flags a contract that ends before it was accepted', async () => {
    quests = [
      questRow({
        accepted_chapter_id: 'n3',
        completed_chapter_id: 'n1',
        status: 'completed',
        giver_character_id: null,
        faction_node_id: null,
      }),
    ];

    const user = await openQuests();

    expect(
      questCard('The Ledger').querySelector('[data-quest-warning="ends-before-start"]')
    ).toHaveTextContent('ends before it is accepted');

    await user.click(screen.getByRole('button', { name: 'Chapters' }));

    expect(continuityText()).toContain('“The Ledger” ends before it is accepted');
    expect(continuityText()).toContain('Chapter One');
  });

  it('flags an open quest whose giver and faction are in the trash', async () => {
    quests = [
      questRow({
        giver_character_id: 'char-gone',
        faction_node_id: 'n-gone',
      }),
    ];

    await openQuests();
    const card = questCard('The Ledger');

    expect(
      card.querySelector('[data-quest-warning="giver-in-trash"]')
    ).toHaveTextContent('giver is in the trash');
    expect(
      card.querySelector('[data-quest-warning="faction-in-trash"]')
    ).toHaveTextContent('faction is in the trash');
  });

  it('flags a payout to someone who is not in the ending chapter', async () => {
    quests = [
      questRow({
        status: 'completed',
        completed_chapter_id: 'n2',
        rewards: [reward('reward-1', 'quest-1', 'xp', 'char-2', '100')],
      }),
    ];
    chapterCast = [
      {
        id: 'cast-1',
        chapter_id: 'n2',
        character_id: 'char-1',
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    await openQuests();

    expect(
      questCard('The Ledger').querySelector(
        '[data-quest-warning="reward-target-absent"]'
      )
    ).toHaveTextContent('pays Mira, who is not in Chapter Two');
  });
});

describe('applying a quest reward', () => {
  it('prefills XP and loot into the chapter and leaves the rest to the sheet', async () => {
    quests = [
      questRow({
        status: 'completed',
        completed_chapter_id: 'n2',
        rewards: [
          reward('reward-1', 'quest-1', 'xp', 'char-1', '250'),
          reward('reward-2', 'quest-1', 'item', 'char-1', 'Iron Key'),
          reward('reward-3', 'quest-1', 'stat', 'char-1', '+2 Strength'),
        ],
      }),
    ];

    const user = await openQuests();
    await user.click(
      within(questCard('The Ledger')).getByRole('button', {
        name: 'Apply rewards to chapter ledger',
      })
    );

    expect(lastCall('add_character_progress')).toMatchObject({
      characterId: 'char-1',
      chapterId: 'n2',
      xpEarned: 250,
      user: 'You',
    });
    expect(lastCall('add_inventory_item')).toMatchObject({
      characterId: 'char-1',
      name: 'Iron Key',
      quantity: 1,
      chapterId: 'n2',
      user: 'You',
    });

    expect(await screen.findByText(/Rook \+250 XP/)).toBeInTheDocument();
    expect(screen.getByText(/Rook \+Iron Key/)).toBeInTheDocument();
    expect(screen.getByText(/1 left for the sheet/)).toBeInTheDocument();
  });

  it('sums two XP payouts for one character into a single row', async () => {
    quests = [
      questRow({
        status: 'completed',
        completed_chapter_id: 'n2',
        rewards: [
          reward('reward-1', 'quest-1', 'xp', 'char-1', '120'),
          reward('reward-2', 'quest-1', 'xp', 'char-1', '80'),
        ],
      }),
    ];

    const user = await openQuests();
    await user.click(
      within(questCard('The Ledger')).getByRole('button', {
        name: 'Apply rewards to chapter ledger',
      })
    );

    expect(lastCall('add_character_progress')).toMatchObject({
      characterId: 'char-1',
      chapterId: 'n2',
      xpEarned: 200,
    });
    expect(screen.getByText(/Rook \+200 XP/)).toBeInTheDocument();
  });

  it('remembers an earlier application without asking on the first click', async () => {
    const paid = reward('reward-1', 'quest-1', 'xp', 'char-1', '100');
    paid.applied_at = '2026-10-22T12:30:00Z';
    quests = [
      questRow({
        status: 'completed',
        completed_chapter_id: 'n2',
        rewards: [paid],
      }),
    ];

    const user = await openQuests();

    await user.click(
      within(questCard('The Ledger')).getByRole('button', {
        name: 'Apply rewards again',
      })
    );

    const prompt = within(questCard('The Ledger')).getByRole('alertdialog', {
      name: 'Apply rewards again',
    });
    expect(prompt).toHaveTextContent('already went into Chapter Two');
    expect(lastCall('add_character_progress')).toBeUndefined();
    expect(lastCall('update_character_progress')).toBeUndefined();
  });

  it('applies only rewards that have not been paid yet', async () => {
    const paid = reward('reward-1', 'quest-1', 'xp', 'char-1', '100');
    paid.applied_at = '2026-10-22T12:30:00Z';
    quests = [
      questRow({
        status: 'completed',
        completed_chapter_id: 'n2',
        rewards: [paid, reward('reward-2', 'quest-1', 'xp', 'char-1', '80')],
      }),
    ];

    const user = await openQuests();

    await user.click(
      within(questCard('The Ledger')).getByRole('button', {
        name: 'Apply new rewards',
      })
    );

    expect(lastCall('add_character_progress')).toMatchObject({
      characterId: 'char-1',
      chapterId: 'n2',
      xpEarned: 80,
    });
    expect(lastCall('mark_quest_rewards_applied')).toMatchObject({
      ids: ['reward-2'],
    });
    expect(screen.getByText(/1 reward was already applied/)).toBeInTheDocument();
  });

  it('asks before applying the same quest a second time', async () => {
    quests = [
      questRow({
        status: 'completed',
        completed_chapter_id: 'n2',
        rewards: [reward('reward-1', 'quest-1', 'xp', 'char-1', '100')],
      }),
    ];

    const applyWrites = () =>
      invokeMock.mock.calls.filter(
        ([command]) =>
          command === 'add_character_progress' || command === 'update_character_progress'
      ).length;

    const user = await openQuests();
    await user.click(
      within(questCard('The Ledger')).getByRole('button', {
        name: 'Apply rewards to chapter ledger',
      })
    );
    expect(applyWrites()).toBe(1);

    await user.click(
      within(questCard('The Ledger')).getByRole('button', {
        name: 'Apply rewards again',
      })
    );

    const prompt = within(questCard('The Ledger')).getByRole('alertdialog', {
      name: 'Apply rewards again',
    });
    expect(prompt).toHaveTextContent('already went into Chapter Two');
    expect(prompt).toHaveTextContent('records the same XP and loot a second time');
    // Nothing is written until the question is answered.
    expect(applyWrites()).toBe(1);

    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    expect(applyWrites()).toBe(1);
    expect(
      within(questCard('The Ledger')).queryByRole('alertdialog', {
        name: 'Apply rewards again',
      })
    ).toBeNull();

    await user.click(
      within(questCard('The Ledger')).getByRole('button', {
        name: 'Apply rewards again',
      })
    );
    await user.click(screen.getByRole('button', { name: 'Add again' }));

    expect(applyWrites()).toBe(2);
  });

  it('adds the payout to an XP row the chapter already has', async () => {
    quests = [
      questRow({
        status: 'completed',
        completed_chapter_id: 'n2',
        rewards: [reward('reward-1', 'quest-1', 'xp', 'char-1', '250')],
      }),
    ];
    progress = [
      {
        id: 'progress-1',
        character_id: 'char-1',
        chapter_id: 'n2',
        xp_earned: 100,
        created_at: '2026-10-22T12:00:00Z',
        updated_at: '2026-10-22T12:00:00Z',
      },
    ];

    const user = await openQuests();
    await user.click(
      within(questCard('The Ledger')).getByRole('button', {
        name: 'Apply rewards to chapter ledger',
      })
    );

    expect(lastCall('update_character_progress')).toMatchObject({
      id: 'progress-1',
      chapterId: 'n2',
      xpEarned: 350,
      user: 'You',
    });
    expect(lastCall('add_character_progress')).toBeUndefined();
    expect(screen.getByText(/Rook \+250 XP \(100 → 350\)/)).toBeInTheDocument();
  });
});
