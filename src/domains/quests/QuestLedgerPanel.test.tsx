import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useState, useEffect } from 'react';
import type { SetStateAction } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Character, CharacterProgress } from '../shared/types';
import type { Story } from '../stories/types';
import { QuestLedgerPanel } from './QuestLedgerPanel';
import type { LedgerChoice, QuestLedgerPanelProps } from './QuestLedgerPanel';
import type { Quest, QuestReward, QuestWarning } from './types';

// The ledger is a pure view: the story's quests arrive as a prop, every write
// leaves through the setter that owns them or through the quests command module,
// and the form drafts belong to the panel. So it renders with no board, no story
// load and no database — the three command modules are mocked, and these tests
// hold the panel to the writes it makes and the rows it draws, rather than to the
// state the app keeps behind it.

const { questsApi, inventoryApi, progressionApi } = vi.hoisted(() => ({
  questsApi: {
    getStoryQuests: vi.fn(),
    addQuest: vi.fn(),
    updateQuest: vi.fn(),
    deleteQuest: vi.fn(),
    addQuestReward: vi.fn(),
    updateQuestReward: vi.fn(),
    deleteQuestReward: vi.fn(),
    markQuestRewardsApplied: vi.fn(),
  },
  inventoryApi: {
    getStoryInventory: vi.fn(),
    addInventoryItem: vi.fn(),
  },
  progressionApi: {
    getStoryCharacterProgress: vi.fn(),
    addCharacterProgress: vi.fn(),
    updateCharacterProgress: vi.fn(),
  },
}));

vi.mock('./api', () => questsApi);
vi.mock('../inventory/api', () => inventoryApi);
vi.mock('../progression/api', () => progressionApi);

const story: Story = {
  id: 's-1',
  title: 'The Vault',
  description: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const mira: Character = {
  id: 'c-1',
  story_id: 's-1',
  name: 'Mira',
  description: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const rook: Character = { ...mira, id: 'c-2', name: 'Rook' };

const chapters: LedgerChoice[] = [
  { id: 'ch-1', label: 'One' },
  { id: 'ch-2', label: 'Two' },
];

const factions: LedgerChoice[] = [{ id: 'f-1', label: 'The Guild' }];

function reward(id: string, overrides: Partial<QuestReward> = {}): QuestReward {
  return {
    id,
    quest_id: 'q-1',
    reward_type: 'xp',
    target_id: 'c-2',
    amount_or_details: '250',
    applied_at: null,
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function quest(id: string, overrides: Partial<Quest> = {}): Quest {
  return {
    id,
    story_id: 's-1',
    title: 'The Ledger',
    giver_character_id: null,
    faction_node_id: null,
    accepted_chapter_id: 'ch-1',
    completed_chapter_id: null,
    status: 'active',
    description: null,
    notes: null,
    created_by: 'Ada',
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    rewards: [],
    ...overrides,
  };
}

function baseProps(overrides: Partial<QuestLedgerPanelProps> = {}): QuestLedgerPanelProps {
  return {
    story,
    actor: 'Ada',
    quests: [],
    setQuests: vi.fn(),
    warnings: [],
    focus: null,
    chapters,
    factions,
    characters: [mira, rook],
    cards: [],
    onOpenCard: vi.fn(),
    placeCard: vi.fn(async () => {}),
    characterProgress: [],
    reloadCharacterProgress: vi.fn(async () => {}),
    reloadInventory: vi.fn(async () => {}),
    createFaction: vi.fn(),
    ...overrides,
  };
}

// The app owns the quests and the panel writes them back through the setter, so
// the harness is that owner: it records every write and applies it, which is what
// makes a saved reward or a deleted quest show up in the list here.
function LedgerHarness(props: QuestLedgerPanelProps) {
  const [quests, setQuests] = useState(props.quests);

  useEffect(() => {
    setQuests(props.quests);
  }, [props.quests]);

  return (
    <QuestLedgerPanel
      {...props}
      quests={quests}
      setQuests={next => {
        (props.setQuests as (value: SetStateAction<Quest[]>) => void)(next);
        setQuests(next);
      }}
    />
  );
}

function renderLedger(overrides: Partial<QuestLedgerPanelProps> = {}) {
  const props = baseProps(overrides);
  const utils = render(<LedgerHarness {...props} />);

  return {
    ...utils,
    props,
    user: userEvent.setup(),
    rerenderWith: (next: Partial<QuestLedgerPanelProps>) =>
      utils.rerender(<LedgerHarness {...props} {...next} />),
  };
}

// A quest card is a labelled region, so each assertion stays inside the contract
// it belongs to rather than reaching into whichever one was drawn first.
function card(title: string) {
  return screen.getByRole('region', { name: `Quest ${title}` });
}

function filterChip(name: string) {
  return within(screen.getByRole('group', { name: 'Quest status filter' })).getByRole(
    'button',
    { name }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  questsApi.addQuestReward.mockResolvedValue(reward('r-new'));
  questsApi.updateQuestReward.mockResolvedValue(reward('r-1'));
  questsApi.deleteQuestReward.mockResolvedValue(undefined);
  questsApi.deleteQuest.mockResolvedValue(undefined);
  questsApi.markQuestRewardsApplied.mockResolvedValue(undefined);
  inventoryApi.addInventoryItem.mockResolvedValue(undefined);
  progressionApi.addCharacterProgress.mockResolvedValue(undefined);
  progressionApi.updateCharacterProgress.mockResolvedValue(undefined);
});

describe('the ledger before it has anything to show', () => {
  it('asks for a story before it offers one', () => {
    renderLedger({ story: null, chapters: [], quests: [] });

    expect(screen.getByText('Load a story to track its quests')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New quest' })).toBeDisabled();
    // No list, no filter and no wording about an empty story: there is nothing
    // to narrow yet.
    expect(screen.queryByRole('group', { name: 'Quest status filter' })).toBeNull();
    expect(screen.queryByText(/No quests yet/)).toBeNull();
    expect(screen.queryByText(/Add a chapter first/)).toBeNull();
  });

  it('asks for a chapter, because a contract is placed by one', () => {
    renderLedger({ chapters: [], quests: [] });

    expect(screen.getByText(/Add a chapter first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New quest' })).toBeDisabled();
    expect(screen.queryByRole('group', { name: 'Quest status filter' })).toBeNull();
  });

  it('says when the story simply has no quests yet', () => {
    renderLedger();

    expect(
      screen.getByText('No quests yet — record one with New quest.')
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('0 of 0');
    expect(screen.getByRole('button', { name: 'New quest' })).toBeEnabled();
    // The filter is drawn as soon as there is a list to narrow, with every
    // status showing.
    expect(filterChip('All')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/Add a chapter first/)).toBeNull();
    expect(screen.queryByText(/Load a story/)).toBeNull();
  });
});

describe('the status filter', () => {
  it('offers the words this story uses, not only the suggested four', () => {
    renderLedger({
      quests: [quest('q-1'), quest('q-2', { id: 'q-2', title: 'The Toll', status: 'on hold' })],
    });

    for (const label of ['All', 'Active', 'Completed', 'Failed', 'Abandoned', 'on hold']) {
      expect(filterChip(label)).toBeInTheDocument();
    }
  });

  it('narrows the list by the chosen status and counts what is left', async () => {
    const { user } = renderLedger({
      quests: [
        quest('q-1'),
        quest('q-2', { id: 'q-2', title: 'The Toll', status: 'failed' }),
      ],
    });

    expect(screen.getByText('The Ledger')).toBeInTheDocument();
    expect(screen.getByText('The Toll')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 of 2');

    await user.click(filterChip('Failed'));

    expect(filterChip('Failed')).toHaveAttribute('aria-pressed', 'true');
    expect(filterChip('All')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('The Ledger')).toBeNull();
    expect(screen.getByText('The Toll')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 of 2');

    await user.click(filterChip('All'));

    expect(screen.getByText('The Ledger')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 of 2');
  });

  it('says so when the chosen status matches nothing', async () => {
    const { user } = renderLedger({ quests: [quest('q-1')] });

    await user.click(filterChip('Failed'));

    expect(screen.getByText('No quests with this status.')).toBeInTheDocument();
    expect(screen.queryByText(/No quests yet/)).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('0 of 1');
  });

  it('puts the filter back and scrolls to the row a chapter badge opened', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const { user, rerenderWith } = renderLedger({
      quests: [
        quest('q-1'),
        quest('q-2', { id: 'q-2', title: 'The Toll', status: 'failed' }),
      ],
    });

    await user.click(filterChip('Failed'));
    expect(screen.queryByText('The Ledger')).toBeNull();

    // The board's badge asks for a quest the filter is hiding: the contract has
    // to be on screen when the eye lands, so the filter goes back to every status.
    rerenderWith({ focus: { questId: 'q-1', request: 1 } });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }));
    expect(filterChip('All')).toHaveAttribute('aria-pressed', 'true');
    expect(card('The Ledger')).toHaveClass('quest-focused');
    expect(card('The Toll')).not.toHaveClass('quest-focused');
  });
});

describe('a quest it shows', () => {
  it('names both chapters and the people a contract touches', () => {
    renderLedger({
      quests: [
        quest('q-1', {
          giver_character_id: 'c-1',
          faction_node_id: 'f-1',
          completed_chapter_id: 'ch-2',
          status: 'completed',
          description: 'Deliver the book.',
          notes: 'Ask about the seal.',
        }),
      ],
    });

    const row = card('The Ledger');

    expect(row).toHaveTextContent('Accepted in One');
    expect(row).toHaveTextContent('Ended in Two');
    expect(row).toHaveTextContent('Giver: Mira');
    expect(row).toHaveTextContent('Faction: The Guild');
    expect(row).toHaveTextContent('Deliver the book.');
    expect(row).toHaveTextContent('Ask about the seal.');
    expect(within(row).getByText('Completed')).toBeInTheDocument();
  });

  it('says when a link points at something in the trash', () => {
    renderLedger({
      quests: [
        quest('q-1', {
          accepted_chapter_id: 'ch-gone',
          completed_chapter_id: 'ch-2',
          giver_character_id: 'c-gone',
          faction_node_id: 'f-gone',
          status: 'completed',
        }),
      ],
      chapters: [{ id: 'ch-2', label: 'Two' }],
      factions: [],
    });

    const row = card('The Ledger');

    expect(row).toHaveTextContent('a chapter in the trash');
    expect(row).toHaveTextContent('cast in the trash');
    expect(row).toHaveTextContent('faction in the trash');
  });

  it('names the card a quest stands for, and says when there is none', async () => {
    const user = userEvent.setup();
    const onOpenCard = vi.fn();
    const placeCard = vi.fn(async () => {});

    renderLedger({
      quests: [
        quest('q-1', { title: 'The Ledger', card_node_id: 'card-1' }),
        // The pointer survives the card going to the trash, so the row can tell
        // the author where it is rather than offering a second card.
        quest('q-2', { title: 'The Toll', card_node_id: 'card-gone' }),
        quest('q-3', { title: 'The Bell' }),
      ],
      cards: [{ id: 'card-1', label: 'The Ledger, a contract' }],
      onOpenCard,
      placeCard,
    });

    const linked = card('The Ledger');
    expect(linked).toHaveTextContent('Card:');
    await user.click(
      within(linked).getByRole('button', { name: 'The Ledger, a contract' })
    );
    expect(onOpenCard).toHaveBeenCalledWith('card-1');

    const trashed = card('The Toll');
    expect(trashed).toHaveTextContent('Card: in the trash');
    expect(within(trashed).queryByRole('button', { name: 'Place card' })).toBeNull();

    const bare = card('The Bell');
    expect(bare).toHaveTextContent('Card: none yet');
    await user.click(within(bare).getByRole('button', { name: 'Place card' }));
    expect(placeCard).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'q-3' }),
      expect.any(Function)
    );
  });

  it('lists the continuity advisories the panel was handed', () => {
    const warnings: QuestWarning[] = [
      {
        id: 'w-1',
        questId: 'q-1',
        questTitle: 'The Ledger',
        kind: 'ends-before-accepted',
        summary: '“The Ledger” ends before it was accepted',
        chapterIds: ['ch-1', 'ch-2'],
      },
    ];

    renderLedger({ quests: [quest('q-1')], warnings });

    const row = card('The Ledger');

    expect(row).toHaveTextContent('ends before it was accepted');
    expect(
      within(row)
        .getByText(/ends before it was accepted/)
        .closest('li')
    ).toHaveAttribute('data-quest-warning', 'ends-before-accepted');
  });
});

describe('the reward editor', () => {
  it('records a reward against the quest and draws it', async () => {
    const { user, props } = renderLedger({ quests: [quest('q-1')] });

    await user.click(within(card('The Ledger')).getByRole('button', { name: 'Add reward' }));

    const editor = within(card('The Ledger'));
    await user.selectOptions(editor.getByLabelText('Reward type'), 'xp');
    await user.selectOptions(editor.getByLabelText('Reward target'), 'c-2');
    await user.type(editor.getByLabelText('Reward amount or details'), '250');
    await user.click(editor.getByRole('button', { name: 'Save reward' }));

    expect(questsApi.addQuestReward).toHaveBeenCalledWith(
      'q-1',
      'xp',
      'c-2',
      '250',
      'Ada'
    );
    // The row is written back through the setter that owns the story's quests.
    expect(props.setQuests).toHaveBeenCalled();

    await waitFor(() =>
      expect(within(card('The Ledger')).getByText('XP')).toBeInTheDocument()
    );
    expect(card('The Ledger')).toHaveTextContent('XPRook250');
    // The editor closes on the save, so the same reward cannot be added twice.
    expect(screen.queryByLabelText('Reward amount or details')).toBeNull();
  });

  it('points a faction standing at a faction card rather than a character', async () => {
    const { user } = renderLedger({ quests: [quest('q-1')] });

    const row = within(card('The Ledger'));
    await user.click(row.getByRole('button', { name: 'Add reward' }));

    const target = row.getByLabelText('Reward target');
    await user.selectOptions(target, 'c-2');

    await user.selectOptions(row.getByLabelText('Reward type'), 'faction_standing');

    expect(
      within(target)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['No target', 'The Guild']);

    await user.selectOptions(target, 'f-1');
    await user.type(row.getByLabelText('Reward amount or details'), '+1 standing');
    await user.click(row.getByRole('button', { name: 'Save reward' }));

    expect(questsApi.addQuestReward).toHaveBeenCalledWith(
      'q-1',
      'faction_standing',
      'f-1',
      '+1 standing',
      'Ada'
    );
  });

  it('drops the cast member already picked when the payout becomes a standing', async () => {
    const { user } = renderLedger({ quests: [quest('q-1')] });

    const row = within(card('The Ledger'));
    await user.click(row.getByRole('button', { name: 'Add reward' }));

    const target = row.getByLabelText('Reward target');
    await user.selectOptions(target, 'c-2');
    expect(target).toHaveValue('c-2');

    await user.selectOptions(row.getByLabelText('Reward type'), 'faction_standing');

    // A character id is not a faction card, so the pick is dropped rather than
    // carried across the change: saving without choosing now names no target.
    await user.click(row.getByRole('button', { name: 'Save reward' }));

    expect(questsApi.addQuestReward).toHaveBeenCalledWith(
      'q-1',
      'faction_standing',
      null,
      null,
      'Ada'
    );
  });

  it('opens a recorded reward with its own values', async () => {
    const { user } = renderLedger({
      quests: [
        quest('q-1', {
          rewards: [reward('r-1', { amount_or_details: '400', applied_at: null })],
        }),
      ],
    });

    await user.click(within(card('The Ledger')).getByTitle('Change this reward'));

    expect(within(card('The Ledger')).getByLabelText('Reward type')).toHaveValue('xp');
    expect(within(card('The Ledger')).getByLabelText('Reward target')).toHaveValue('c-2');
    expect(within(card('The Ledger')).getByLabelText('Reward amount or details')).toHaveValue(
      '400'
    );
  });

  it('leaves the bundle alone when the editor is cancelled', async () => {
    const { user } = renderLedger({ quests: [quest('q-1')] });

    const row = within(card('The Ledger'));
    await user.click(row.getByRole('button', { name: 'Add reward' }));
    await user.click(row.getByRole('button', { name: 'Cancel' }));

    expect(questsApi.addQuestReward).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Reward type')).toBeNull();
  });

  it('deletes a reward from the bundle', async () => {
    const { user } = renderLedger({
      quests: [quest('q-1', { rewards: [reward('r-1')] })],
    });

    await user.click(within(card('The Ledger')).getByTitle('Delete this reward'));

    expect(questsApi.deleteQuestReward).toHaveBeenCalledWith('r-1', 'Ada');
    await waitFor(() =>
      expect(within(card('The Ledger')).getByText('No rewards recorded.')).toBeInTheDocument()
    );
  });
});

describe('applying a reward bundle', () => {
  const paidQuest = (overrides: Partial<Quest> = {}) =>
    quest('q-1', {
      completed_chapter_id: 'ch-2',
      status: 'completed',
      rewards: [
        reward('r-xp', { reward_type: 'xp', target_id: 'c-2', amount_or_details: '250' }),
        reward('r-item', { reward_type: 'item', target_id: 'c-2', amount_or_details: 'Dagger' }),
        reward('r-stat', { reward_type: 'stat', target_id: 'c-1', amount_or_details: '+2 Str' }),
      ],
      ...overrides,
    });

  it('offers to pay only once the contract has ended and has rewards', () => {
    renderLedger({
      quests: [
        quest('q-1', { completed_chapter_id: null }),
        quest('q-2', { id: 'q-2', title: 'The Toll', completed_chapter_id: 'ch-2' }),
      ],
    });

    // No ending chapter, no payout button; no rewards, no payout button either.
    expect(
      within(card('The Ledger')).queryByRole('button', { name: /Apply/ })
    ).toBeNull();
    expect(
      within(card('The Toll')).queryByRole('button', { name: /Apply/ })
    ).toBeNull();
  });

  it('pays XP and loot into the ledger and leaves the rest to the sheet', async () => {
    const { user, props } = renderLedger({ quests: [paidQuest()] });

    await user.click(
      within(card('The Ledger')).getByRole('button', {
        name: 'Apply rewards to chapter ledger',
      })
    );

    await waitFor(() => expect(progressionApi.addCharacterProgress).toHaveBeenCalled());
    expect(progressionApi.addCharacterProgress).toHaveBeenCalledWith('c-2', 'ch-2', 250, 'Ada');
    expect(inventoryApi.addInventoryItem).toHaveBeenCalledWith(
      'c-2',
      'Dagger',
      null,
      1,
      'Reward from The Ledger',
      'ch-2',
      null,
      null,
      'Ada'
    );
    // Only the payouts that reached the ledger are stamped as applied.
    expect(questsApi.markQuestRewardsApplied).toHaveBeenCalledWith(['r-item', 'r-xp']);
    // The two reads a payout joins are reloaded by the app, not patched here.
    expect(props.reloadCharacterProgress).toHaveBeenCalled();
    expect(props.reloadInventory).toHaveBeenCalled();

    const notice = await screen.findByText(/Rook \+Dagger/);
    expect(notice).toHaveTextContent('Rook +250 XP');
    expect(notice).toHaveTextContent('1 left for the sheet.');
  });

  it('adds a payout to the income row the chapter already holds', async () => {
    const existing: CharacterProgress = {
      id: 'p-1',
      character_id: 'c-2',
      chapter_id: 'ch-2',
      xp_earned: 400,
      created_at: '2026-01-03T00:00:00Z',
      updated_at: '2026-01-03T00:00:00Z',
    };

    const { user } = renderLedger({
      quests: [
        quest('q-1', {
          completed_chapter_id: 'ch-2',
          status: 'completed',
          rewards: [reward('r-xp', { amount_or_details: '250' })],
        }),
      ],
      characterProgress: [existing],
    });

    await user.click(
      within(card('The Ledger')).getByRole('button', {
        name: 'Apply rewards to chapter ledger',
      })
    );

    // One income row per character and chapter, so the payout joins it rather
    // than being refused for existing.
    await waitFor(() =>
      expect(progressionApi.updateCharacterProgress).toHaveBeenCalledWith(
        'p-1',
        'ch-2',
        650,
        'Ada'
      )
    );
    expect(progressionApi.addCharacterProgress).not.toHaveBeenCalled();
    expect(await screen.findByText(/400 → 650/)).toBeInTheDocument();
  });

  it('asks before paying the same bundle a second time', async () => {
    const paid = new Date('2026-01-04T00:00:00Z').toISOString();

    const { user } = renderLedger({
      quests: [
        quest('q-1', {
          completed_chapter_id: 'ch-2',
          status: 'completed',
          rewards: [
            reward('r-xp', { amount_or_details: '250', applied_at: paid }),
            reward('r-item', { reward_type: 'item', amount_or_details: 'Dagger', applied_at: paid }),
          ],
        }),
      ],
    });

    const applyButton = within(card('The Ledger')).getByRole('button', {
      name: 'Apply rewards again',
    });

    await user.click(applyButton);

    const dialog = screen.getByRole('alertdialog', { name: 'Apply rewards again' });
    expect(dialog).toHaveTextContent('already went into Two');
    // The question is asked before anything is written.
    expect(progressionApi.addCharacterProgress).not.toHaveBeenCalled();
    expect(inventoryApi.addInventoryItem).not.toHaveBeenCalled();
    expect(questsApi.markQuestRewardsApplied).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(progressionApi.addCharacterProgress).not.toHaveBeenCalled();
  });

  it('pays again only after the answer to that question', async () => {
    const paid = new Date('2026-01-04T00:00:00Z').toISOString();

    const { user } = renderLedger({
      quests: [
        quest('q-1', {
          completed_chapter_id: 'ch-2',
          status: 'completed',
          rewards: [reward('r-xp', { amount_or_details: '250', applied_at: paid })],
        }),
      ],
    });

    await user.click(
      within(card('The Ledger')).getByRole('button', { name: 'Apply rewards again' })
    );
    await user.click(screen.getByRole('button', { name: 'Add again' }));

    await waitFor(() =>
      expect(progressionApi.addCharacterProgress).toHaveBeenCalledWith('c-2', 'ch-2', 250, 'Ada')
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('pays only what has not reached the ledger yet, without asking', async () => {
    const paid = new Date('2026-01-04T00:00:00Z').toISOString();

    const { user } = renderLedger({
      quests: [
        quest('q-1', {
          completed_chapter_id: 'ch-2',
          status: 'completed',
          rewards: [
            reward('r-xp-old', { amount_or_details: '250', applied_at: paid }),
            reward('r-item-new', {
              reward_type: 'item',
              amount_or_details: 'Dagger',
              applied_at: null,
            }),
          ],
        }),
      ],
    });

    await user.click(
      within(card('The Ledger')).getByRole('button', { name: 'Apply new rewards' })
    );

    // A half-paid bundle is not a question: the unpaid half is simply added.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() =>
      expect(questsApi.markQuestRewardsApplied).toHaveBeenCalledWith(['r-item-new'])
    );
    expect(inventoryApi.addInventoryItem).toHaveBeenCalledTimes(1);
    expect(progressionApi.addCharacterProgress).not.toHaveBeenCalled();
    expect(await screen.findByText(/1 reward was already applied\./)).toBeInTheDocument();
  });

  it('says nothing could be paid when every payout is unusable', async () => {
    const { user } = renderLedger({
      quests: [
        quest('q-1', {
          completed_chapter_id: 'ch-2',
          status: 'completed',
          rewards: [reward('r-xp', { target_id: null, amount_or_details: '250' })],
        }),
      ],
    });

    await user.click(
      within(card('The Ledger')).getByRole('button', {
        name: 'Apply rewards to chapter ledger',
      })
    );

    expect(
      await screen.findByText(/1 reward has no target or numeric amount\./)
    ).toBeInTheDocument();
    expect(questsApi.markQuestRewardsApplied).not.toHaveBeenCalled();
  });
});

describe('the quest form', () => {
  it('saves a quest with the chapter it was accepted in', async () => {
    questsApi.addQuest.mockResolvedValue(quest('q-9', { title: 'The Toll' }));

    const { user } = renderLedger();

    await user.click(screen.getByRole('button', { name: 'New quest' }));
    await user.type(screen.getByLabelText('Quest title'), 'The Toll');
    await user.selectOptions(screen.getByLabelText('Quest accepted chapter'), 'ch-2');
    await user.selectOptions(screen.getByLabelText('Quest giver'), 'c-1');
    await user.click(screen.getByRole('button', { name: 'Save quest' }));

    expect(questsApi.addQuest).toHaveBeenCalledWith(
      's-1',
      'The Toll',
      'c-1',
      null,
      'ch-2',
      null,
      'active',
      null,
      null,
      'Ada'
    );
    expect(await screen.findByText('The Toll')).toBeInTheDocument();
  });

  it('refuses a contract with no title, and says why', async () => {
    const { user } = renderLedger();

    await user.click(screen.getByRole('button', { name: 'New quest' }));
    await user.selectOptions(screen.getByLabelText('Quest accepted chapter'), 'ch-1');
    await user.click(screen.getByRole('button', { name: 'Save quest' }));

    expect(questsApi.addQuest).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('A quest needs a title.');
  });

  it('makes an ending chapter and an ended status agree', async () => {
    const { user } = renderLedger({ quests: [quest('q-1', { status: 'active' })] });

    await user.click(within(card('The Ledger')).getByTitle('Edit “The Ledger”'));

    // Choosing the chapter a contract ended in ends it; clearing the chapter
    // reopens a contract that was only marked completed.
    await user.selectOptions(screen.getByLabelText('Quest completed chapter'), 'ch-2');
    expect(screen.getByLabelText('Quest status')).toHaveValue('completed');

    await user.selectOptions(screen.getByLabelText('Quest completed chapter'), '');
    expect(screen.getByLabelText('Quest status')).toHaveValue('active');
  });

  it('clears an open form when the story changes', async () => {
    const { user, rerenderWith } = renderLedger();

    await user.click(screen.getByRole('button', { name: 'New quest' }));
    expect(screen.getByLabelText('Quest title')).toBeInTheDocument();

    rerenderWith({ story: { ...story, id: 's-2', title: 'The Other Vault' } });

    await waitFor(() => expect(screen.queryByLabelText('Quest title')).toBeNull());
  });
});
