import React, { useEffect, useMemo, useState } from 'react';
import { SuggestionInput } from '../../components/SuggestionInput';
import * as inventoryApi from '../inventory/api';
import * as progressionApi from '../progression/api';
import type { CharacterProgress } from '../shared/types';
import type { Character } from '../shared/types';
import type { Story } from '../stories/types';
import * as questsApi from './api';
import {
  filterQuests,
  questRewardLabels,
  questRewardTypes,
  questStatusChoices,
  questStatusFilterLabel,
  questStatusLabels,
  rewardApplicationState,
  warningsByQuest,
} from './ledger';
import type { Quest, QuestReward, QuestWarning } from './types';

// The Quests tab: the ledger of contracts, its reward bundles and what each
// bundle pays out. The form's draft, the reward draft, the status filter and the
// apply notices belong to this view alone, so they live here; the story's quests
// are read by the board's chapter cards and restored by the undo history, so
// they arrive as a prop and are written back through the setter that owns them.
// A drag off a chapter that spawns a quest, and the badge that opens one, stay in
// the app and reach the panel as a focus request.
//
// Applying a bundle is the one action here that writes outside the domain: XP
// becomes a chapter income row and loot becomes an inventory item. The panel
// makes those writes itself, the way the ledger always has, and asks the app to
// reload the two reads it shares with the chart and the sheets.

// The quest form's fields, one draft at a time. A null id means a new quest.
interface QuestDraft {
  id: string | null;
  title: string;
  giver: string;
  faction: string;
  accepted: string;
  completed: string;
  status: string;
  description: string;
  notes: string;
}

// The reward form's fields, likewise one draft at a time.
interface QuestRewardDraft {
  id: string | null;
  questId: string;
  type: string;
  target: string;
  details: string;
}

// A chapter or a faction card, as a form needs it: the id to store and the label
// to show. Kept apart from the board's node type so the panel never reads one.
export interface LedgerChoice {
  id: string;
  label: string;
}

export interface QuestLedgerPanelProps {
  story: Story | null;
  actor: string;

  // The story's quests, and the write that puts a saved row back among them.
  quests: Quest[];
  setQuests: React.Dispatch<React.SetStateAction<Quest[]>>;
  // The advisory list the continuity panel also reads, grouped here per quest.
  warnings: QuestWarning[];
  // The quest a chapter badge just opened, and which click opened it: a second
  // click on the same badge is a fresh request, so the list is put back to every
  // status and the row is scrolled to again.
  focus: { questId: string; request: number } | null;

  chapters: LedgerChoice[];
  factions: LedgerChoice[];
  characters: Character[];

  // The two reads a payout reaches: income rows, and what it puts in a bag.
  characterProgress: CharacterProgress[];
  reloadCharacterProgress: () => Promise<void>;
  reloadInventory: () => Promise<void>;
  // Makes a faction card on the board and hands its id back, so the quest and
  // the standing forms can name a faction without leaving the form.
  createFaction: (
    name: string,
    onCreated: (id: string) => void,
    onError: (message: string) => void
  ) => void;
}

export function QuestLedgerPanel({
  story,
  actor,
  quests,
  setQuests,
  warnings,
  focus,
  chapters,
  factions,
  characters,
  characterProgress,
  reloadCharacterProgress,
  reloadInventory,
  createFaction,
}: QuestLedgerPanelProps) {
  const [questFilter, setQuestFilter] = useState('all');
  const [questError, setQuestError] = useState<string | null>(null);
  // What the last Apply rewards run did, so a partially applied bundle says so.
  const [questNotice, setQuestNotice] = useState<string | null>(null);
  const [questDraft, setQuestDraft] = useState<QuestDraft | null>(null);
  const [rewardDraft, setRewardDraft] = useState<QuestRewardDraft | null>(null);
  // A faction can be made from the forms that need one, rather than sending the
  // author to the Graph tab and back.
  const [newQuestFactionName, setNewQuestFactionName] = useState('');
  const [applyingRewardsQuestId, setApplyingRewardsQuestId] = useState<string | null>(
    null
  );
  // The quest waiting on an answer before its rewards are applied again.
  const [questApplyConfirmId, setQuestApplyConfirmId] = useState<string | null>(null);

  // A form and the quest it was opened for do not carry over to another story.
  useEffect(() => {
    setQuestDraft(null);
    setRewardDraft(null);
    setQuestError(null);
    setQuestNotice(null);
    setQuestFilter('all');
    setQuestApplyConfirmId(null);
  }, [story?.id]);

  // A chapter card's quest badge opens the ledger on that quest. The list is put
  // back to every status so the contract cannot be filtered out of sight, and the
  // row is scrolled to once it has been drawn.
  useEffect(() => {
    if (!focus) return;

    setQuestFilter('all');
    setQuestError(null);

    const handle = window.setTimeout(() => {
      document
        .querySelector(`[data-quest-id="${focus.questId}"]`)
        ?.scrollIntoView?.({ block: 'nearest' });
    }, 0);

    return () => window.clearTimeout(handle);
  }, [focus]);

  const statusChoices = useMemo(() => questStatusChoices(quests), [quests]);

  const filteredQuests = useMemo(
    () => filterQuests(quests, questFilter),
    [quests, questFilter]
  );

  const chapterLabelById = useMemo(
    () => new Map(chapters.map(chapter => [chapter.id, chapter.label])),
    [chapters]
  );

  const characterNameById = useMemo(
    () => new Map(characters.map(character => [character.id, character.name])),
    [characters]
  );

  const questWarningsByQuest = useMemo(() => warningsByQuest(warnings), [warnings]);

  // A quest is kept with its reward bundle, so it is replaced whole rather than
  // field by field. The order matches the database: acceptance position first.
  const applyQuest = (saved: Quest) => {
    setQuests(previous =>
      [...previous.filter(quest => quest.id !== saved.id), saved].sort(
        (a, b) =>
          (a.accepted_chapter_id ?? '').localeCompare(b.accepted_chapter_id ?? '') ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id)
      )
    );
  };

  const startNewQuest = () => {
    setQuestError(null);
    setQuestNotice(null);
    setRewardDraft(null);
    setQuestDraft({
      id: null,
      title: '',
      giver: '',
      faction: '',
      accepted: '',
      completed: '',
      status: 'active',
      description: '',
      notes: '',
    });
  };

  const startQuestEdit = (quest: Quest) => {
    setQuestError(null);
    setQuestNotice(null);
    setRewardDraft(null);
    setQuestDraft({
      id: quest.id,
      title: quest.title,
      giver: quest.giver_character_id ?? '',
      faction: quest.faction_node_id ?? '',
      accepted: quest.accepted_chapter_id ?? '',
      completed: quest.completed_chapter_id ?? '',
      status: quest.status,
      description: quest.description ?? '',
      notes: quest.notes ?? '',
    });
  };

  const saveQuestDraft = async () => {
    if (!questDraft || !story) return;

    const title = questDraft.title.trim();
    const status = questDraft.status.trim();

    if (!title) {
      setQuestError('A quest needs a title.');
      return;
    }

    if (!status) {
      setQuestError('A quest needs a status.');
      return;
    }

    if (!questDraft.accepted) {
      setQuestError('Choose the chapter the quest is accepted in.');
      return;
    }

    // An ending chapter and a status that says nothing has ended cannot both be
    // true. The form keeps them in step, so this only catches hand-edited words.
    const ended = ['completed', 'failed', 'abandoned'].includes(status.toLowerCase());

    if (ended && !questDraft.completed) {
      setQuestError(
        'Choose the chapter this quest ended in, or set its status back to active.'
      );
      return;
    }

    if (questDraft.completed && status.toLowerCase() === 'active') {
      setQuestError(
        'An active quest cannot have an ending chapter; clear it or choose another status.'
      );
      return;
    }

    setQuestError(null);

    try {
      const payload = {
        title,
        giverCharacterId: questDraft.giver || null,
        factionNodeId: questDraft.faction || null,
        acceptedChapterId: questDraft.accepted,
        completedChapterId: questDraft.completed || null,
        status,
        description: questDraft.description.trim() || null,
        notes: questDraft.notes.trim() || null,
      };
      const saved: Quest = questDraft.id
        ? await questsApi.updateQuest(
            questDraft.id,
            payload.title,
            payload.giverCharacterId,
            payload.factionNodeId,
            payload.acceptedChapterId,
            payload.completedChapterId,
            payload.status,
            payload.description,
            payload.notes,
            actor
          )
        : await questsApi.addQuest(
            story.id,
            payload.title,
            payload.giverCharacterId,
            payload.factionNodeId,
            payload.acceptedChapterId,
            payload.completedChapterId,
            payload.status,
            payload.description,
            payload.notes,
            actor
          );

      applyQuest(saved);
      setQuestDraft(null);
      setQuestApplyConfirmId(null);
    } catch (e) {
      console.error('Failed to save a quest:', e);
      setQuestError(`Could not save the quest: ${String(e)}`);
    }
  };

  const removeQuest = async (quest: Quest) => {
    setQuestError(null);

    try {
      await questsApi.deleteQuest(quest.id, actor);
      setQuests(previous => previous.filter(other => other.id !== quest.id));

      if (questDraft?.id === quest.id) setQuestDraft(null);
      if (rewardDraft?.questId === quest.id) setRewardDraft(null);
    } catch (e) {
      console.error('Failed to delete a quest:', e);
      setQuestError(`Could not delete the quest: ${String(e)}`);
    }
  };

  const startNewReward = (quest: Quest) => {
    setQuestError(null);
    setRewardDraft({
      id: null,
      questId: quest.id,
      type: 'xp',
      target: '',
      details: '',
    });
  };

  const startRewardEdit = (reward: QuestReward) => {
    setQuestError(null);
    setRewardDraft({
      id: reward.id,
      questId: reward.quest_id,
      type: reward.reward_type,
      target: reward.target_id ?? '',
      details: reward.amount_or_details ?? '',
    });
  };

  const saveRewardDraft = async () => {
    if (!rewardDraft) return;

    setQuestError(null);

    try {
      const payload = {
        rewardType: rewardDraft.type,
        targetId: rewardDraft.target || null,
        amountOrDetails: rewardDraft.details.trim() || null,
      };
      const saved: QuestReward = rewardDraft.id
        ? await questsApi.updateQuestReward(
            rewardDraft.id,
            payload.rewardType,
            payload.targetId,
            payload.amountOrDetails,
            actor
          )
        : await questsApi.addQuestReward(
            rewardDraft.questId,
            payload.rewardType,
            payload.targetId,
            payload.amountOrDetails,
            actor
          );

      setQuests(previous =>
        previous.map(quest =>
          quest.id === saved.quest_id
            ? {
                ...quest,
                rewards: [...quest.rewards.filter(other => other.id !== saved.id), saved],
              }
            : quest
        )
      );
      setRewardDraft(null);
      // A changed bundle is a different payout, so the warning is recalculated.
      setQuestApplyConfirmId(null);
    } catch (e) {
      console.error('Failed to save a quest reward:', e);
      setQuestError(`Could not save the reward: ${String(e)}`);
    }
  };

  const removeReward = async (reward: QuestReward) => {
    setQuestError(null);

    try {
      await questsApi.deleteQuestReward(reward.id, actor);
      setQuests(previous =>
        previous.map(quest =>
          quest.id === reward.quest_id
            ? {
                ...quest,
                rewards: quest.rewards.filter(other => other.id !== reward.id),
              }
            : quest
        )
      );
      if (rewardDraft?.id === reward.id) setRewardDraft(null);
      setQuestApplyConfirmId(null);
    } catch (e) {
      console.error('Failed to delete a quest reward:', e);
      setQuestError(`Could not delete the reward: ${String(e)}`);
    }
  };

  // Prefills the chapter ledger from a finished quest: XP into each character's
  // income row, loot into their inventory. A row the chapter already holds is
  // added to rather than duplicated. A stat change and a faction standing depend
  // on the author's own wording, so those are left to the sheet.
  const applyQuestRewards = async (quest: Quest, again = false) => {
    if (!story) return;

    const chapterId = quest.completed_chapter_id;

    if (!chapterId) {
      setQuestError('Record the chapter this quest ended in before applying rewards.');
      return;
    }

    if (quest.rewards.length === 0) {
      setQuestError('This quest has no rewards to apply.');
      return;
    }

    setQuestError(null);
    setQuestNotice(null);
    setApplyingRewardsQuestId(quest.id);

    let xpRows = 0;
    let itemRows = 0;
    let manual = 0;
    let already = 0;
    let unusable = 0;
    let failed = 0;
    const applied: string[] = [];
    const appliedRewardIds: string[] = [];
    // One payout per character and chapter, summed before writing: the ledger
    // holds one income row per pair, so two XP rewards must not overwrite each
    // other with the same old total.
    const xpPayouts = new Map<
      string,
      { characterId: string; amount: number; rewardIds: string[] }
    >();

    try {
      for (const reward of quest.rewards) {
        const details = (reward.amount_or_details ?? '').trim();
        const name = reward.target_id
          ? (characterNameById.get(reward.target_id) ?? 'the target')
          : null;

        // A reward the ledger already received is left alone unless the author
        // explicitly confirmed a second application.
        if (
          reward.applied_at &&
          !again &&
          (reward.reward_type === 'xp' || reward.reward_type === 'item')
        ) {
          already += 1;
          continue;
        }

        if (!reward.target_id) {
          unusable += 1;
          continue;
        }

        if (reward.reward_type === 'xp') {
          if (!/^\d+$/.test(details) || Number(details) <= 0) {
            unusable += 1;
            continue;
          }

          const key = `${reward.target_id}::${chapterId}`;
          const payout = xpPayouts.get(key);

          if (payout) {
            payout.amount += Number(details);
            payout.rewardIds.push(reward.id);
          } else {
            xpPayouts.set(key, {
              characterId: reward.target_id,
              amount: Number(details),
              rewardIds: [reward.id],
            });
          }

          continue;
        }

        try {
          if (reward.reward_type === 'item') {
            if (!details) {
              unusable += 1;
              continue;
            }

            await inventoryApi.addInventoryItem(
              reward.target_id,
              details,
              null,
              1,
              `Reward from ${quest.title}`,
              chapterId,
              null,
              null,
              actor
            );
            applied.push(`${name} +${details}`);
            appliedRewardIds.push(reward.id);
            itemRows += 1;
          } else {
            // A stat gain and a faction standing are written in the author's
            // words, so they are applied on the sheet rather than guessed at.
            manual += 1;
          }
        } catch (e) {
          console.error('Failed to apply a quest reward:', e);
          failed += 1;
        }
      }

      for (const payout of xpPayouts.values()) {
        const name = characterNameById.get(payout.characterId) ?? 'the target';

        try {
          const existing = characterProgress.find(
            row =>
              row.character_id === payout.characterId && row.chapter_id === chapterId
          );

          // One income row per character and chapter, so a payout joins the row
          // already there rather than being refused for its existence.
          if (existing) {
            const newTotal = existing.xp_earned + payout.amount;

            await progressionApi.updateCharacterProgress(
              existing.id,
              chapterId,
              newTotal,
              actor
            );
            applied.push(
              `${name} +${payout.amount} XP (${existing.xp_earned} → ${newTotal})`
            );
          } else {
            await progressionApi.addCharacterProgress(
              payout.characterId,
              chapterId,
              payout.amount,
              actor
            );
            applied.push(`${name} +${payout.amount} XP`);
          }

          appliedRewardIds.push(...payout.rewardIds);
          xpRows += 1;
        } catch (e) {
          console.error('Failed to apply a quest XP reward:', e);
          failed += 1;
        }
      }

      if (xpRows > 0) await reloadCharacterProgress();
      if (itemRows > 0) await reloadInventory();

      // The database remembers which payouts reached the ledger, so the warning
      // survives a restart. A failure here only weakens that memory; the XP and
      // loot themselves are already written.
      let remembered = true;

      if (appliedRewardIds.length > 0) {
        try {
          await questsApi.markQuestRewardsApplied(appliedRewardIds);
        } catch (e) {
          console.error('Failed to remember the applied quest rewards:', e);
          remembered = false;
        }

        const stamp = new Date().toISOString();

        setQuests(previous =>
          previous.map(other =>
            other.id === quest.id
              ? {
                  ...other,
                  rewards: other.rewards.map(row =>
                    appliedRewardIds.includes(row.id)
                      ? { ...row, applied_at: stamp }
                      : row
                  ),
                }
              : other
          )
        );
      }

      setQuestNotice(
        [
          applied.length > 0
            ? `Applied ${applied.join('; ')} for “${quest.title}”.`
            : manual > 0
              ? `No automatic payouts for “${quest.title}”.`
              : `Nothing could be applied for “${quest.title}”.`,
          already > 0
            ? `${already} reward${already === 1 ? ' was' : 's were'} already applied.`
            : null,
          manual > 0 ? `${manual} left for the sheet.` : null,
          unusable > 0
            ? `${unusable} reward${unusable === 1 ? ' has' : 's have'} no target or numeric amount.`
            : null,
          failed > 0 ? `${failed} could not be recorded.` : null,
          remembered
            ? null
            : 'The applied rewards could not be remembered, so a restart may not warn before applying them again.',
        ]
          .filter(Boolean)
          .join(' ')
      );
    } finally {
      setApplyingRewardsQuestId(null);
    }
  };

  // Apply pays only what has not reached the ledger yet; paying everything again
  // is offered behind the confirmation instead.
  const requestQuestRewardApply = (quest: Quest) => {
    const { automatic } = rewardApplicationState(quest);

    if (automatic.length > 0 && automatic.every(reward => reward.applied_at)) {
      setQuestApplyConfirmId(quest.id);
      return;
    }

    void applyQuestRewards(quest);
  };

  return (
    <div className="tab-content">
      <div className="quests-layout">
        <div className="quests-header">
          <div>
            <h2 className="quests-title">Quests &amp; contracts</h2>
            <p className="quests-caption">
              A contract is placed by the chapter it was accepted in and, once
              it ends, by the chapter that closed it. Rewards are recorded as
              payouts rather than applied until you ask for them.
            </p>
          </div>
          <div className="quests-actions">
            <span className="quests-count" role="status">
              {filteredQuests.length} of {quests.length}
            </span>
            <button
              type="button"
              className="quest-new-button"
              title="Record a new quest or contract"
              disabled={!story || chapters.length === 0}
              onClick={startNewQuest}
            >
              New quest
            </button>
          </div>
        </div>

        {questError && (
          <div className="quest-error" role="alert">
            {questError}
          </div>
        )}

        {questNotice && (
          <div className="quest-notice" role="status">
            {questNotice}
          </div>
        )}

        {!story ? (
          <div className="empty-state">Load a story to track its quests</div>
        ) : chapters.length === 0 ? (
          <div className="empty-state">
            Add a chapter first — a quest is placed by the chapter it is
            accepted in.
          </div>
        ) : (
          <>
            {questDraft && (
              <form
                className="quest-editor"
                aria-label={questDraft.id ? 'Edit quest' : 'New quest'}
                onSubmit={event => {
                  event.preventDefault();
                  void saveQuestDraft();
                }}
              >
                <div className="quest-editor-head">
                  <h3>{questDraft.id ? 'Edit quest' : 'New quest'}</h3>
                  <span className="quest-editor-hint">
                    {questDraft.id
                      ? 'Every changed field goes into the history.'
                      : 'The acceptance chapter is required.'}
                  </span>
                </div>

                <input
                  aria-label="Quest title"
                  title="The quest or contract's name"
                  placeholder="Title"
                  autoFocus
                  value={questDraft.title}
                  onChange={event =>
                    setQuestDraft({ ...questDraft, title: event.target.value })
                  }
                />

                <div className="quest-editor-row">
                  <SuggestionInput
                    label="Quest status"
                    title="Active, completed, failed, abandoned — or your own word"
                    placeholder="Status"
                    value={questDraft.status}
                    suggestions={statusChoices}
                    onChange={status => setQuestDraft({ ...questDraft, status })}
                  />

                  <select
                    aria-label="Quest giver"
                    title="The cast member who issued it, if one did"
                    value={questDraft.giver}
                    onChange={event =>
                      setQuestDraft({ ...questDraft, giver: event.target.value })
                    }
                  >
                    <option value="">No giver</option>
                    {characters.map(character => (
                      <option key={character.id} value={character.id}>
                        {character.name}
                      </option>
                    ))}
                  </select>

                  <div className="quest-editor-field quest-faction-field">
                    <span>Faction</span>
                    <select
                      aria-label="Quest faction"
                      title="The faction card that issued it, if any"
                      value={questDraft.faction}
                      onChange={event =>
                        setQuestDraft({ ...questDraft, faction: event.target.value })
                      }
                    >
                      <option value="">No faction</option>
                      {factions.map(faction => (
                        <option key={faction.id} value={faction.id}>
                          {faction.label}
                        </option>
                      ))}
                    </select>
                    <span className="faction-quick-add">
                      <input
                        aria-label="New quest faction name"
                        title="Make a faction card and issue this quest from it"
                        placeholder="New faction…"
                        value={newQuestFactionName}
                        onChange={event => setNewQuestFactionName(event.target.value)}
                        onKeyDown={event => {
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          void createFaction(
                            newQuestFactionName,
                            id => {
                              setQuestDraft(draft =>
                                draft ? { ...draft, faction: id } : draft
                              );
                              setNewQuestFactionName('');
                            },
                            setQuestError
                          );
                        }}
                      />
                      <button
                        type="button"
                        title="Create this faction card and choose it"
                        disabled={!newQuestFactionName.trim()}
                        onClick={() =>
                          void createFaction(
                            newQuestFactionName,
                            id => {
                              setQuestDraft(draft =>
                                draft ? { ...draft, faction: id } : draft
                              );
                              setNewQuestFactionName('');
                            },
                            setQuestError
                          )
                        }
                      >
                        Add faction
                      </button>
                    </span>
                  </div>
                </div>

                <div className="quest-editor-row">
                  <label className="quest-editor-field">
                    <span>Accepted in</span>
                    <select
                      aria-label="Quest accepted chapter"
                      value={questDraft.accepted}
                      onChange={event =>
                        setQuestDraft({ ...questDraft, accepted: event.target.value })
                      }
                    >
                      <option value="">Choose chapter…</option>
                      {chapters.map(chapter => (
                        <option key={chapter.id} value={chapter.id}>
                          {chapter.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="quest-editor-field">
                    <span>Ended in</span>
                    <select
                      aria-label="Quest completed chapter"
                      title="Optional: the chapter it was completed, failed or abandoned in"
                      value={questDraft.completed}
                      onChange={event => {
                        const completed = event.target.value;
                        const status = questDraft.status.trim().toLowerCase();

                        // The chapter is what ends a contract, so choosing
                        // one makes an open quest completed; clearing it
                        // opens a quest that was only marked completed.
                        setQuestDraft({
                          ...questDraft,
                          completed,
                          status: completed
                            ? status === '' || status === 'active'
                              ? 'completed'
                              : questDraft.status
                            : ['completed', 'failed', 'abandoned'].includes(status)
                              ? 'active'
                              : questDraft.status,
                        });
                      }}
                    >
                      <option value="">Still open</option>
                      {chapters.map(chapter => (
                        <option key={chapter.id} value={chapter.id}>
                          {chapter.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <textarea
                  aria-label="Quest description"
                  title="The objectives or terms, in your own words"
                  placeholder="Objectives or terms"
                  rows={2}
                  value={questDraft.description}
                  onChange={event =>
                    setQuestDraft({ ...questDraft, description: event.target.value })
                  }
                />

                <textarea
                  aria-label="Quest notes"
                  title="Bookkeeping notes for you, not the story"
                  placeholder="Notes"
                  rows={2}
                  value={questDraft.notes}
                  onChange={event =>
                    setQuestDraft({ ...questDraft, notes: event.target.value })
                  }
                />

                <div className="quest-editor-buttons">
                  <button type="submit" title="Save this quest and its placement">
                    Save quest
                  </button>
                  <button
                    type="button"
                    title="Leave the quest as it was"
                    onClick={() => setQuestDraft(null)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            <div className="quest-filter" role="group" aria-label="Quest status filter">
              {['all', ...statusChoices].map(status => (
                <button
                  type="button"
                  key={status}
                  className={questFilter === status ? 'active' : ''}
                  aria-pressed={questFilter === status}
                  title={
                    status === 'all'
                      ? 'Show every quest'
                      : `Show only ${questStatusFilterLabel(status)} quests`
                  }
                  onClick={() => setQuestFilter(status)}
                >
                  {questStatusFilterLabel(status)}
                </button>
              ))}
            </div>

            <div className="quest-list">
              {filteredQuests.length === 0 && (
                <div className="empty">
                  {quests.length === 0
                    ? 'No quests yet — record one with New quest.'
                    : 'No quests with this status.'}
                </div>
              )}

              {filteredQuests.map(quest => {
                const acceptedLabel = quest.accepted_chapter_id
                  ? (chapterLabelById.get(quest.accepted_chapter_id) ??
                    'a chapter in the trash')
                  : 'no chapter recorded';
                const completedLabel = quest.completed_chapter_id
                  ? (chapterLabelById.get(quest.completed_chapter_id) ??
                    'a chapter in the trash')
                  : null;
                const giverName = quest.giver_character_id
                  ? (characterNameById.get(quest.giver_character_id) ??
                    'cast in the trash')
                  : null;
                const factionName = quest.faction_node_id
                  ? (factions.find(faction => faction.id === quest.faction_node_id)
                      ?.label ?? 'faction in the trash')
                  : null;
                const warnings = questWarningsByQuest.get(quest.id) ?? [];
                const focused = focus?.questId === quest.id;
                const statusKey = quest.status.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
                const { allApplied, anyApplied } = rewardApplicationState(quest);

                return (
                  <section
                    key={quest.id}
                    className={`quest-card${focused ? ' quest-focused' : ''}`}
                    data-quest-id={quest.id}
                    aria-label={`Quest ${quest.title}`}
                  >
                    <div className="quest-card-head">
                      <div className="quest-card-title">
                        <h3>{quest.title}</h3>
                        <span
                          className={`quest-status quest-status-${statusKey}`}
                          title="The quest's status"
                        >
                          {questStatusLabels[quest.status] ?? quest.status}
                        </span>
                      </div>
                      <div className="quest-card-actions">
                        <button
                          type="button"
                          title={`Edit “${quest.title}”`}
                          onClick={() => startQuestEdit(quest)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          title={`Delete “${quest.title}”`}
                          onClick={() => void removeQuest(quest)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div className="quest-card-meta">
                      <span>
                        Accepted in <strong>{acceptedLabel}</strong>
                      </span>
                      <span>
                        {completedLabel ? (
                          <>
                            Ended in <strong>{completedLabel}</strong>
                          </>
                        ) : (
                          'Still open'
                        )}
                      </span>
                      {giverName && <span>Giver: {giverName}</span>}
                      {factionName && <span>Faction: {factionName}</span>}
                    </div>

                    {quest.description && (
                      <p className="quest-description">{quest.description}</p>
                    )}
                    {quest.notes && <p className="quest-notes">{quest.notes}</p>}

                    {warnings.length > 0 && (
                      <ul className="quest-warnings">
                        {warnings.map(warning => (
                          <li key={warning.id} data-quest-warning={warning.kind}>
                            <span className="quest-warning-mark" aria-hidden="true">
                              !
                            </span>
                            {warning.summary}
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="quest-rewards">
                      <div className="quest-rewards-head">
                        <h4>Rewards</h4>
                        <button
                          type="button"
                          title="Record a payout for this quest"
                          onClick={() => startNewReward(quest)}
                        >
                          Add reward
                        </button>
                      </div>

                      {quest.rewards.length === 0 && (
                        <div className="empty">No rewards recorded.</div>
                      )}

                      <ul className="quest-reward-list">
                        {quest.rewards.map(reward => {
                          const targetName =
                            reward.reward_type === 'faction_standing'
                              ? (factions.find(
                                  faction => faction.id === reward.target_id
                                )?.label ??
                                (reward.target_id ? 'a faction in the trash' : 'no target'))
                              : reward.target_id
                                ? (characterNameById.get(reward.target_id) ??
                                  'cast in the trash')
                                : 'no target';

                          return (
                            <li key={reward.id} className="quest-reward-row">
                              <span className="quest-reward-kind">
                                {questRewardLabels[reward.reward_type] ??
                                  reward.reward_type}
                              </span>
                              <span className="quest-reward-target">{targetName}</span>
                              <span className="quest-reward-details">
                                {reward.amount_or_details?.trim() || 'no details'}
                              </span>
                              <button
                                type="button"
                                title="Change this reward"
                                onClick={() => startRewardEdit(reward)}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                title="Delete this reward"
                                onClick={() => void removeReward(reward)}
                              >
                                Delete
                              </button>
                            </li>
                          );
                        })}
                      </ul>

                      {rewardDraft?.questId === quest.id && (
                        <div className="quest-reward-editor">
                          <select
                            aria-label="Reward type"
                            value={rewardDraft.type}
                            onChange={event =>
                              setRewardDraft({
                                ...rewardDraft,
                                type: event.target.value,
                                target: '',
                              })
                            }
                          >
                            {questRewardTypes.map(type => (
                              <option key={type} value={type}>
                                {questRewardLabels[type]}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label="Reward target"
                            title={
                              rewardDraft.type === 'faction_standing'
                                ? 'The faction card whose standing changes'
                                : 'The cast member who receives it'
                            }
                            value={rewardDraft.target}
                            onChange={event =>
                              setRewardDraft({
                                ...rewardDraft,
                                target: event.target.value,
                              })
                            }
                          >
                            <option value="">No target</option>
                            {(rewardDraft.type === 'faction_standing'
                              ? factions.map(faction => ({
                                  id: faction.id,
                                  label: faction.label,
                                }))
                              : characters.map(character => ({
                                  id: character.id,
                                  label: character.name,
                                }))
                            ).map(choice => (
                              <option key={choice.id} value={choice.id}>
                                {choice.label}
                              </option>
                            ))}
                          </select>
                          <input
                            aria-label="Reward amount or details"
                            title="A number for XP, a name for an item, or the author's words"
                            placeholder={
                              rewardDraft.type === 'xp'
                                ? 'XP amount'
                                : rewardDraft.type === 'item'
                                  ? 'Item name'
                                  : 'Details'
                            }
                            value={rewardDraft.details}
                            onChange={event =>
                              setRewardDraft({
                                ...rewardDraft,
                                details: event.target.value,
                              })
                            }
                          />
                          <div className="quest-reward-editor-buttons">
                            <button
                              type="button"
                              title="Save this reward on the quest"
                              onClick={() => void saveRewardDraft()}
                            >
                              Save reward
                            </button>
                            <button
                              type="button"
                              title="Leave the rewards as they were"
                              onClick={() => setRewardDraft(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {quest.completed_chapter_id && quest.rewards.length > 0 && (
                      <div className="quest-apply">
                        {questApplyConfirmId === quest.id ? (
                          <div
                            className="quest-apply-confirm"
                            role="alertdialog"
                            aria-label="Apply rewards again"
                          >
                            <p>
                              These rewards already went into {completedLabel} for “
                              {quest.title}”. Adding them again records the same XP
                              and loot a second time.
                            </p>
                            <div className="quest-apply-confirm-actions">
                              <button
                                type="button"
                                title="Add the same rewards a second time"
                                onClick={() => {
                                  setQuestApplyConfirmId(null);
                                  void applyQuestRewards(quest, true);
                                }}
                              >
                                Add again
                              </button>
                              <button
                                type="button"
                                title="Keep the ledger as it is"
                                onClick={() => setQuestApplyConfirmId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            title={
                              allApplied
                                ? `These rewards were already applied to ${completedLabel}; applying again asks first`
                                : anyApplied
                                  ? `Add only the rewards that have not reached ${completedLabel} yet`
                                  : `Add this quest's XP and loot to ${completedLabel}, joining any XP row already there without touching stat gains or standings`
                            }
                            disabled={applyingRewardsQuestId === quest.id}
                            onClick={() => requestQuestRewardApply(quest)}
                          >
                            {applyingRewardsQuestId === quest.id
                              ? 'Applying…'
                              : allApplied
                                ? 'Apply rewards again'
                                : anyApplied
                                  ? 'Apply new rewards'
                                  : 'Apply rewards to chapter ledger'}
                          </button>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
