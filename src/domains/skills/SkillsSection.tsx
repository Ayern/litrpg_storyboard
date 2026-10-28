import { useEffect, useMemo, useState } from 'react';
import { HelpTip } from '../../components/HelpTip';
import { milestoneLabel } from '../progression/helpers';
import type {
  CharacterLevelMilestone,
  CharacterSkill,
  SkillEvolution,
} from '../shared/types';
import type { CharacterSkillEvent, SkillEventKind } from './types';

// The sheet's skill rows: what each skill is, what it grew out of and what it
// becomes, and the changes recorded against it. The form state lives here - the
// open row and what its fields hold - while every write is handed back to the
// app, because a skill also has a card on the canvas, a place in the history
// and, when it was drawn, a connection.

export interface SkillDraft {
  name: string;
  rank: string | null;
  effect: string | null;
  chapterId: string | null;
  nodeId: string | null;
}

export interface SkillEventDraft {
  kind: SkillEventKind;
  chapterId: string | null;
  rank: string | null;
  milestoneId: string | null;
}

// A chapter or a card a skill can point at, as a label rather than a canvas node.
export interface SkillOption {
  id: string;
  label: string;
}

// What the Progression tab asked this sheet to open, if anything.
export interface SkillFocus {
  kind: string;
  id: string;
}

export function SkillsSection({
  skills,
  storySkills,
  events,
  evolutions,
  chapters,
  cards,
  milestones,
  chapterSeqById,
  focus,
  onError,
  onCreate,
  onSave,
  onDelete,
  onSaveEvent,
  onDeleteEvent,
}: {
  // The character's own rows, and every live row, so an evolution chip can name
  // a skill somebody else holds.
  skills: CharacterSkill[];
  storySkills: CharacterSkill[];
  events: CharacterSkillEvent[];
  evolutions: SkillEvolution[];
  // The chapters and skill cards a skill can point at, already labelled.
  chapters: SkillOption[];
  cards: SkillOption[];
  milestones: CharacterLevelMilestone[];
  // Where each chapter sits in the reading order, so a skill's events read in
  // story order rather than in the order they were typed.
  chapterSeqById: Map<string, number>;
  focus: SkillFocus | null;
  onError: (message: string | null) => void;
  onCreate: (input: SkillDraft) => Promise<boolean>;
  onSave: (skill: CharacterSkill, input: SkillDraft) => Promise<boolean>;
  onDelete: (skill: CharacterSkill) => Promise<boolean>;
  onSaveEvent: (
    skillId: string,
    eventId: string | null,
    input: SkillEventDraft
  ) => Promise<boolean>;
  onDeleteEvent: (event: CharacterSkillEvent) => Promise<boolean>;
}) {
  // The skill form, one row open at a time like stats and attributes.
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillRank, setNewSkillRank] = useState('');
  const [newSkillEffect, setNewSkillEffect] = useState('');
  const [newSkillChapterId, setNewSkillChapterId] = useState('');
  const [newSkillNodeId, setNewSkillNodeId] = useState('');
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [skillNameDraft, setSkillNameDraft] = useState('');
  const [skillRankDraft, setSkillRankDraft] = useState('');
  const [skillEffectDraft, setSkillEffectDraft] = useState('');
  const [skillChapterDraft, setSkillChapterDraft] = useState('');
  const [skillNodeDraft, setSkillNodeDraft] = useState('');
  const [addingSkillEventFor, setAddingSkillEventFor] = useState<string | null>(null);
  const [editingSkillEventId, setEditingSkillEventId] = useState<string | null>(null);
  const [skillEventKindDraft, setSkillEventKindDraft] = useState<SkillEventKind>('upgraded');
  const [skillEventChapterDraft, setSkillEventChapterDraft] = useState('');
  const [skillEventRankDraft, setSkillEventRankDraft] = useState('');
  const [skillEventMilestoneDraft, setSkillEventMilestoneDraft] = useState('');

  const skillEventsBySkill = useMemo(() => {
    const grouped = new Map<string, CharacterSkillEvent[]>();

    for (const event of events) {
      grouped.set(event.skill_id, [...(grouped.get(event.skill_id) ?? []), event]);
    }

    for (const group of grouped.values()) {
      group.sort(
        (a, b) =>
          (chapterSeqById.get(a.chapter_id ?? '') ?? Number.MAX_SAFE_INTEGER) -
            (chapterSeqById.get(b.chapter_id ?? '') ?? Number.MAX_SAFE_INTEGER) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id)
      );
    }

    return grouped;
  }, [events, chapterSeqById]);

  // The two sides of every evolution, grouped once so a sheet's skill rows can
  // name what came before and what comes next without searching the list twice.
  const skillEvolutionByChild = useMemo(() => {
    const grouped = new Map<string, SkillEvolution[]>();

    for (const evolution of evolutions) {
      grouped.set(evolution.child_skill_id, [
        ...(grouped.get(evolution.child_skill_id) ?? []),
        evolution,
      ]);
    }

    return grouped;
  }, [evolutions]);

  const skillEvolutionByParent = useMemo(() => {
    const grouped = new Map<string, SkillEvolution[]>();

    for (const evolution of evolutions) {
      grouped.set(evolution.parent_skill_id, [
        ...(grouped.get(evolution.parent_skill_id) ?? []),
        evolution,
      ]);
    }

    return grouped;
  }, [evolutions]);

  const skillNameById = useMemo(
    () => new Map(storySkills.map(skill => [skill.id, skill.name])),
    [storySkills]
  );

  const startSkillEdit = (skill: CharacterSkill) => {
    onError(null);
    setAddingSkillEventFor(null);
    setEditingSkillEventId(null);
    setEditingSkillId(skill.id);
    setSkillNameDraft(skill.name);
    setSkillRankDraft(skill.rank ?? '');
    setSkillEffectDraft(skill.effect ?? '');
    setSkillChapterDraft(skill.chapter_id ?? '');
    setSkillNodeDraft(skill.node_id ?? '');
  };

  const startAddSkillEvent = (skillId: string) => {
    onError(null);
    setEditingSkillId(null);
    setAddingSkillEventFor(skillId);
    setEditingSkillEventId(null);
    setSkillEventKindDraft('upgraded');
    setSkillEventChapterDraft('');
    setSkillEventRankDraft('');
    setSkillEventMilestoneDraft('');
  };

  const startSkillEventEdit = (event: CharacterSkillEvent) => {
    onError(null);
    setEditingSkillId(null);
    setAddingSkillEventFor(null);
    setEditingSkillEventId(event.id);
    setSkillEventKindDraft(event.kind);
    setSkillEventChapterDraft(event.chapter_id ?? '');
    setSkillEventRankDraft(event.rank ?? '');
    setSkillEventMilestoneDraft(event.milestone_id ?? '');
  };

  const cancelSkillEventEdit = () => {
    setAddingSkillEventFor(null);
    setEditingSkillEventId(null);
    onError(null);
  };

  // A continuity warning on the Progression tab names the exact row that
  // contradicts the story, so the sheet opens its editor instead of leaving the
  // author to find it. The app hands over a fresh focus each time a warning is
  // clicked, so the same warning clicked twice opens the editor twice; a focus
  // naming another row closes what is open here, while the highlight simply
  // timing out leaves the editor alone.
  useEffect(() => {
    if (!focus) return;

    const skill = skills.find(entry => entry.id === focus.id);
    const event = events.find(entry => entry.id === focus.id);

    if (focus.kind === 'skill-event' && event) {
      startSkillEventEdit(event);
      return;
    }

    if (focus.kind === 'skill' && skill) {
      startSkillEdit(skill);
      return;
    }

    if (focus.kind !== 'skill' && focus.kind !== 'skill-event') {
      setEditingSkillId(null);
      setAddingSkillEventFor(null);
      setEditingSkillEventId(null);
    }
    // Only a new focus reopens a row: the lists changing under an open editor
    // must not put the saved values back over what is being typed.
  }, [focus]);

  // The name is the one field the sheet will not save empty: a row with no name
  // is not a skill, and deleting it is how it goes away.
  const saveSkill = async (skill: CharacterSkill) => {
    const name = skillNameDraft.trim();

    if (!name) {
      onError('A skill needs a name — delete it to remove it.');
      return;
    }

    const saved = await onSave(skill, {
      name,
      rank: skillRankDraft.trim() || null,
      effect: skillEffectDraft.trim() || null,
      chapterId: skillChapterDraft || null,
      nodeId: skillNodeDraft || null,
    });

    if (saved) setEditingSkillId(null);
  };

  const addSkill = async () => {
    const name = newSkillName.trim();

    if (!name) return;

    const saved = await onCreate({
      name,
      rank: newSkillRank.trim() || null,
      effect: newSkillEffect.trim() || null,
      chapterId: newSkillChapterId || null,
      nodeId: newSkillNodeId || null,
    });

    if (!saved) return;

    setNewSkillName('');
    setNewSkillRank('');
    setNewSkillEffect('');
    setNewSkillChapterId('');
    setNewSkillNodeId('');
  };

  // Deleting a row closes whatever was open on it, but only once it is really
  // gone: a refused delete leaves the editor where the author left it.
  const removeSkill = async (skill: CharacterSkill) => {
    const openEvent = events.find(event => event.id === editingSkillEventId);
    const deleted = await onDelete(skill);

    if (!deleted) return;

    if (openEvent && openEvent.skill_id === skill.id) cancelSkillEventEdit();
    setEditingSkillId(null);
  };

  const saveSkillEvent = async (skillId: string, eventId: string | null) => {
    const kind = skillEventKindDraft;

    const saved = await onSaveEvent(skillId, eventId, {
      kind,
      chapterId: skillEventChapterDraft || null,
      rank: kind === 'sacrificed' ? null : skillEventRankDraft.trim() || null,
      milestoneId: skillEventMilestoneDraft || null,
    });

    if (saved) cancelSkillEventEdit();
  };

  const removeSkillEvent = async (event: CharacterSkillEvent) => {
    const deleted = await onDeleteEvent(event);

    if (deleted && editingSkillEventId === event.id) cancelSkillEventEdit();
  };

  return (
    <div className="skill-section">
      <div className="character-section-head">
        <h4 className="character-section-heading">Skills</h4>
        <HelpTip label="skill cards and the sheets that hold them">
          A skill’s name, rank and effect belong to the skill itself,
          not to one holder. A card and every sheet that holds it
          show the same values, so editing the card reaches all of
          them at once — as one undo step — and the sheet’s links say
          what it grew out of and what it becomes.
        </HelpTip>
      </div>

      <div className="skill-list">
        {skills.length === 0 && (
          <div className="empty">
            No skills yet — add one below.
          </div>
        )}

        {skills.map(skill => {
          const chapter = chapters.find(
            choice => choice.id === skill.chapter_id
          );
          const card = cards.find(
            choice => choice.id === skill.node_id
          );
          const skillEvents = skillEventsBySkill.get(skill.id) ?? [];
          const prerequisites = skillEvolutionByChild.get(skill.id) ?? [];
          const outcomes = skillEvolutionByParent.get(skill.id) ?? [];
          const skillFocused =
            focus?.kind === 'skill' &&
            focus.id === skill.id;
          const renderEventForm = (event: CharacterSkillEvent | null) => (
            <div className="skill-event-editor">
              <select
                aria-label="Skill event kind"
                title="What happened to this skill in that chapter"
                value={skillEventKindDraft}
                onChange={(e) =>
                  setSkillEventKindDraft(e.target.value as SkillEventKind)
                }
              >
                <option value="upgraded">Upgraded</option>
                <option value="used">Used</option>
                <option value="sacrificed">Sacrificed or lost</option>
              </select>
              <select
                aria-label="Skill event chapter"
                title="The chapter where this happened"
                value={skillEventChapterDraft}
                onChange={(e) => setSkillEventChapterDraft(e.target.value)}
              >
                <option value="">No chapter</option>
                {skillEventChapterDraft &&
                  !chapters.some(
                    choice => choice.id === skillEventChapterDraft
                  ) && (
                    <option value={skillEventChapterDraft}>
                      Chapter in the trash
                    </option>
                  )}
                {chapters.map(choice => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Skill event level-up"
                title="The level-up this change came with, if any"
                value={skillEventMilestoneDraft}
                onChange={(e) => {
                  const milestoneId = e.target.value;
                  setSkillEventMilestoneDraft(milestoneId);
                  // A skill keeps its own clock, so the level-up is a note about
                  // what came with the change rather than where it happened. Its
                  // chapter only fills in one the author left blank.
                  const milestone = milestones.find(
                    entry => entry.id === milestoneId
                  );
                  if (milestone?.chapter_id && !skillEventChapterDraft) {
                    setSkillEventChapterDraft(milestone.chapter_id);
                  }
                }}
              >
                <option value="">No level-up</option>
                {skillEventMilestoneDraft &&
                  !milestones.some(
                    milestone => milestone.id === skillEventMilestoneDraft
                  ) && (
                    <option value={skillEventMilestoneDraft}>
                      Level-up not on this sheet
                    </option>
                  )}
                {milestones.map(milestone => (
                  <option key={milestone.id} value={milestone.id}>
                    {milestoneLabel(milestone)}
                  </option>
                ))}
              </select>
              <input
                aria-label="Skill event rank"
                placeholder="Rank (optional)"
                title="The rank reached or used; a sacrifice has none"
                disabled={skillEventKindDraft === 'sacrificed'}
                value={
                  skillEventKindDraft === 'sacrificed'
                    ? ''
                    : skillEventRankDraft
                }
                onChange={(e) => setSkillEventRankDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveSkillEvent(skill.id, event?.id ?? null);
                  if (e.key === 'Escape') cancelSkillEventEdit();
                }}
              />
              <div className="skill-event-actions">
                <button
                  title={`Save this change to ${skill.name}`}
                  onClick={() => saveSkillEvent(skill.id, event?.id ?? null)}
                >
                  Save event
                </button>
                <button
                  title="Leave this skill event as it was"
                  onClick={cancelSkillEventEdit}
                >
                  Cancel
                </button>
              </div>
            </div>
          );

          return (
            <div
              key={skill.id}
              className={`skill-row${skillFocused ? ' progression-row-focused' : ''}`}
              data-progression={`skill-${skill.id}`}
            >
              <div className="skill-row-head">
              {editingSkillId === skill.id ? (
                <div className="skill-editor">
                  <input
                    aria-label="Skill name"
                    autoFocus
                    value={skillNameDraft}
                    onChange={(e) => setSkillNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveSkill(skill);
                      if (e.key === 'Escape') setEditingSkillId(null);
                    }}
                  />
                  <input
                    aria-label="Skill rank"
                    placeholder="Rank (optional)"
                    value={skillRankDraft}
                    onChange={(e) => setSkillRankDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveSkill(skill);
                      if (e.key === 'Escape') setEditingSkillId(null);
                    }}
                  />
                  <input
                    aria-label="Skill effect"
                    placeholder="Effect (optional)"
                    value={skillEffectDraft}
                    onChange={(e) => setSkillEffectDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveSkill(skill);
                      if (e.key === 'Escape') setEditingSkillId(null);
                    }}
                  />
                  <select
                    aria-label="Chapter acquired"
                    title="The chapter this skill was learned in"
                    value={skillChapterDraft}
                    onChange={(e) => setSkillChapterDraft(e.target.value)}
                  >
                    <option value="">No chapter</option>
                    {skillChapterDraft &&
                      !chapters.some(
                        choice => choice.id === skillChapterDraft
                      ) && (
                        <option value={skillChapterDraft}>
                          Chapter in the trash
                        </option>
                      )}
                    {chapters.map(choice => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Skill card"
                    title="The skill card this skill belongs to"
                    value={skillNodeDraft}
                    onChange={(e) => setSkillNodeDraft(e.target.value)}
                  >
                    <option value="">No card</option>
                    {skillNodeDraft &&
                      !cards.some(
                        choice => choice.id === skillNodeDraft
                      ) && (
                        <option value={skillNodeDraft}>
                          Card in the trash
                        </option>
                      )}
                    {cards.map(choice => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                  <div className="skill-actions">
                    <button
                      title={`Save this ${skill.name}`}
                      onClick={() => saveSkill(skill)}
                    >
                      Save
                    </button>
                    <button
                      title="Leave the skill as it was"
                      onClick={() => setEditingSkillId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="skill-summary">
                    <span className="skill-name">{skill.name}</span>
                    {skill.rank && (
                      <span className="skill-rank">{skill.rank}</span>
                    )}
                    {skill.effect && (
                      <span className="skill-effect">{skill.effect}</span>
                    )}
                    <span className="skill-chapter">
                      {chapter
                        ? `Learned in ${chapter.label}`
                        : skill.chapter_id
                          ? 'Chapter in the trash'
                          : 'Chapter not recorded'}
                    </span>
                    {card && (
                      <span className="skill-card-link">
                        Card: {card.label}
                      </span>
                    )}
                    {(prerequisites.length > 0 || outcomes.length > 0) && (
                      <div className="skill-evolution-links">
                        {prerequisites.map(evolution => (
                          <span
                            key={`requires-${evolution.id}`}
                            className="skill-evolution-link requires"
                            title={`This skill's ${
                              evolution.evolution_type
                            } link to ${
                              skillNameById.get(
                                evolution.parent_skill_id
                              ) ?? 'a skill in the trash'
                            }`}
                          >
                            Requires{' '}
                            {skillNameById.get(
                              evolution.parent_skill_id
                            ) ?? 'a skill in the trash'}
                            {evolution.required_rank
                              ? ` · ${evolution.required_rank}`
                              : ''}
                          </span>
                        ))}
                        {outcomes.map(evolution => (
                          <span
                            key={`outcome-${evolution.id}`}
                            className="skill-evolution-link outcome"
                            title={`${
                              skillNameById.get(
                                evolution.child_skill_id
                              ) ?? 'A skill in the trash'
                            } follows this skill by ${
                              evolution.evolution_type
                            }`}
                          >
                            →{' '}
                            {skillNameById.get(
                              evolution.child_skill_id
                            ) ?? 'a skill in the trash'}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    title={`Change ${skill.name}'s rank, effect or chapter`}
                    onClick={() => startSkillEdit(skill)}
                  >
                    Edit
                  </button>
                  <button
                    title={`Delete ${skill.name}`}
                    onClick={() => removeSkill(skill)}
                  >
                    Delete
                  </button>
                </>
              )}
              </div>

              <div className="skill-events" aria-label={`${skill.name} events`}>
                {skillEvents.map(event => {
                  const eventChapter = chapters.find(
                    choice => choice.id === event.chapter_id
                  );
                  const focused =
                    focus?.kind === 'skill-event' &&
                    focus.id === event.id;
                  const eventMilestone = milestones.find(
                    milestone => milestone.id === event.milestone_id
                  );
                  const label =
                    event.kind === 'upgraded'
                      ? event.rank
                        ? `Upgraded to ${event.rank}`
                        : 'Upgraded'
                      : event.kind === 'used'
                        ? event.rank
                          ? `Used at ${event.rank}`
                          : 'Used'
                        : 'Sacrificed or lost';

                  return (
                    <div
                      key={event.id}
                      className={`skill-event-row${focused ? ' progression-row-focused' : ''}`}
                      data-progression={`skill-event-${event.id}`}
                    >
                      {editingSkillEventId === event.id ? (
                        renderEventForm(event)
                      ) : (
                        <>
                          <div className="skill-event-summary">
                            <span className="skill-event-kind">{label}</span>
                            <span className="skill-event-chapter">
                              {eventChapter
                                ? eventChapter.label
                                : event.chapter_id
                                  ? 'Chapter in the trash'
                                  : 'No chapter recorded'}
                            </span>
                            {eventMilestone && (
                              <span className="skill-event-level">
                                At {milestoneLabel(eventMilestone)}
                              </span>
                            )}
                          </div>
                          <button
                            title={`Change this ${skill.name} event`}
                            onClick={() => startSkillEventEdit(event)}
                          >
                            Edit
                          </button>
                          <button
                            title={`Delete this ${skill.name} event`}
                            onClick={() => removeSkillEvent(event)}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}

                {addingSkillEventFor === skill.id ? (
                  renderEventForm(null)
                ) : editingSkillEventId == null ? (
                  <button
                    className="skill-event-add"
                    title={`Record an upgrade, use or sacrifice of ${skill.name}`}
                    onClick={() => startAddSkillEvent(skill.id)}
                  >
                    Add event
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="skill-creator">
        <input
          aria-label="New skill name"
          placeholder="Skill"
          value={newSkillName}
          onChange={(e) => setNewSkillName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addSkill()}
        />
        <input
          aria-label="New skill rank"
          placeholder="Rank"
          value={newSkillRank}
          onChange={(e) => setNewSkillRank(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addSkill()}
        />
        <input
          aria-label="New skill effect"
          placeholder="Effect"
          value={newSkillEffect}
          onChange={(e) => setNewSkillEffect(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addSkill()}
        />
        <select
          aria-label="New skill chapter"
          title="The chapter this skill was learned in"
          value={newSkillChapterId}
          onChange={(e) => setNewSkillChapterId(e.target.value)}
        >
          <option value="">No chapter</option>
          {chapters.map(choice => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
        <select
          aria-label="New skill card"
          title="The skill card this skill belongs to"
          value={newSkillNodeId}
          onChange={(e) => setNewSkillNodeId(e.target.value)}
        >
          <option value="">No card</option>
          {cards.map(choice => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
        <button
          title="Add this skill to the selected character"
          onClick={addSkill}
          disabled={!newSkillName.trim()}
        >
          Add skill
        </button>
      </div>
    </div>
  );
}
