import { useEffect, useRef, useState } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { HelpTip } from '../../components/HelpTip';
import { formatCount } from '../../lib/format';
import type { ChapterEventRow } from './types';
import type { ChapterEventType } from '../narrative/types';
import type { ChapterCastBadge, NodeData } from './types';
import { isNodeType, NODE_STAT_BADGES, QUEST_BADGES_SHOWN } from './types';

// The card a node is drawn as. Its type is both the colour of its edge and the
// word above the label, so a board reads at a glance instead of every note
// looking the same. A linked node also carries its cast member's numbers, so a
// board of characters shows who is ahead without opening anybody. The handles
// keep a node connectable from either side.
export function GraphNode({ data, isConnectable }: NodeProps<NodeData>) {
  const kind = isNodeType(data.nodeType) ? data.nodeType : 'misc';
  const stats = data.characterStats ?? [];
  const shown = stats.slice(0, NODE_STAT_BADGES);
  const hidden = stats.length - shown.length;
  const linked = Boolean(data.characterId);
  const level = data.characterLevel ?? null;
  const holders = data.skillHolders ?? [];
  const itemHolders = data.inventoryHolders ?? [];
  const continuityFlags = data.continuityFlags ?? [];
  const chapterCast = data.chapterCast ?? [];
  const questBadges = data.questBadges ?? [];
  const castChoices = data.castChoices ?? [];
  const objectives = data.chapterTasks ?? [];

  // The card's own two small forms, which open over the face rather than in a
  // panel: who is in the scene, and what the scene pays out. Only one is up at a
  // time, because they cover the same corner of the card.
  const [face, setFace] = useState<'cast' | 'event' | null>(null);
  const [objectiveDraft, setObjectiveDraft] = useState('');
  const [eventActorId, setEventActorId] = useState('');
  const [eventType, setEventType] = useState<ChapterEventType>('xp_award');
  const [eventDetails, setEventDetails] = useState('');
  const [eventAmount, setEventAmount] = useState('');
  const [eventSkillId, setEventSkillId] = useState('');
  const [keepBaseSkill, setKeepBaseSkill] = useState(true);
  const [keepOnSheet, setKeepOnSheet] = useState(true);
  const [eventError, setEventError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const events = data.chapterEvents ?? [];

  const eventTarget =
    eventActorId ||
    data.chapterPov ||
    chapterCast[0]?.characterId ||
    castChoices[0]?.id ||
    '';
  const actorSkills = data.chapterSkills?.[eventTarget] ?? [];
  // The first skill is the one the form acts on until the author picks another;
  // a selection made for a different actor does not carry across.
  const chosenSkillId =
    eventSkillId && actorSkills.some(skill => skill.id === eventSkillId)
      ? eventSkillId
      : (actorSkills[0]?.id ?? '');
  const chosenSkill = actorSkills.find(skill => skill.id === chosenSkillId);
  const skillEvent =
    eventType === 'skill_rank_up' ||
    eventType === 'skill_evolve' ||
    eventType === 'skill_sacrifice';
  const doneObjectives = objectives.filter(task => task.done).length;

  const submitObjective = async () => {
    const text = objectiveDraft.trim();
    if (!text || !data.onAddChapterObjective) return;

    const added = await data.onAddChapterObjective(text);
    if (added !== false) setObjectiveDraft('');
  };

  // The event's own form resets its fields when its kind changes: an item's
  // quantity is not an XP amount, and a skill's name is not a rank-up line.
  const chooseEventType = (next: ChapterEventType) => {
    setEventType(next);
    setEventDetails('');
    setEventAmount(next === 'item_acquire' ? '1' : '');
    setEventSkillId('');
    setKeepBaseSkill(true);
    setKeepOnSheet(true);
    setEventError(null);
  };

  const submitEvent = async () => {
    if (!data.onAddChapterEvent || !eventTarget) return;

    const details = eventDetails.trim();
    const amount = eventAmount.trim() === '' ? null : Number(eventAmount);

    if (eventType === 'xp_award' && (!Number.isInteger(amount) || Number(amount) <= 0)) {
      setEventError('A whole number of XP above zero.');
      return;
    }

    if (eventType === 'item_acquire' && (!Number.isInteger(amount) || Number(amount) < 1)) {
      setEventError('A quantity of at least one.');
      return;
    }

    if (skillEvent && !chosenSkillId) {
      setEventError('Choose a skill.');
      return;
    }

    if (
      (eventType === 'skill_learn' || eventType === 'skill_evolve' || 
        eventType === 'item_acquire') &&
      details === ''
    ) {
      setEventError('Add a detail line.');
      return;
    }

    setEventError(null);
    const added = await data.onAddChapterEvent(
      eventTarget,
      eventType,
      details,
      amount,
      skillEvent ? chosenSkillId : null,
      keepBaseSkill,
      keepOnSheet
    );

    if (added !== false) {
      setEventDetails('');
      setEventAmount(eventType === 'item_acquire' ? '1' : '');
      setEventSkillId('');
      setKeepBaseSkill(true);
      setKeepOnSheet(true);
      setFace(null);
    }
  };

  const eventIcon = (type: ChapterEventType) =>
    ({
      xp_award: '⚡',
      skill_learn: '🔥',
      skill_rank_up: '↑',
      skill_evolve: '✨',
      skill_sacrifice: '💀',
      item_acquire: '🗡️',
    })[type];

  const eventWhat = (event: ChapterEventRow) => {
    switch (event.event_type) {
      case 'xp_award':
        return `+${formatCount(event.amount ?? 0)} XP`;
      case 'skill_learn':
        return `learns ${event.details}`;
      case 'skill_evolve':
        return `evolves into ${event.details}`;
      case 'skill_sacrifice':
        return `sacrifices ${event.details}`;
      case 'item_acquire':
        return `${event.details} ×${event.amount ?? 1}`;
      default:
        return event.details;
    }
  };

  // A form opened on the card can always be put away: Escape does it, and so
  // does a press anywhere off the card. Clicking Cast again still toggles it.
  useEffect(() => {
    if (!face) return;

    const closeOnOutside = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) setFace(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape belongs to the card's form, not to the tab behind it.
      event.stopPropagation();
      setFace(null);
    };

    document.addEventListener('pointerdown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnEscape, true);

    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [face]);

  const castSkillText = (member: ChapterCastBadge) =>
    member.skills.length === 0
      ? 'No active skills yet'
      : member.skills
          .map(skill => (skill.rank ? `${skill.name} (${skill.rank})` : skill.name))
          .join(', ');
  const castLevelText = (member: ChapterCastBadge) =>
    member.level !== null
      ? `Level ${member.level}${member.levelIsPenalty ? ' (penalty)' : ''}`
      : 'No level recorded as of this chapter';

  return (
    <>
    <div
      ref={cardRef}
      className={`graph-node ${kind}${kind === 'chapter' ? ' workbench' : ''}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
      <span className="graph-node-topline">
        <span className="graph-node-kind">{kind}</span>
        {kind === 'chapter' && data.chapterSeq != null && (
          <span className="graph-node-chapter" title="Place in the reading order">
            Ch. {data.chapterSeq}
          </span>
        )}
      </span>
      <span className="graph-node-label">{data.label}</span>
      {/* A chapter card names the cast whose snapshot applies there. The badge is
          a real button, so the hover title works with a keyboard too, and the
          help dot says where the list comes from: three places on the chapter,
          not one. */}
      {/* The scene's own words, so a chapter card can be read without opening
          the drawer: what happens here, in the author's summary. */}
      {kind === 'chapter' && (
        <p className="chapter-summary" title={data.content?.trim() || undefined}>
          {data.content?.trim() || (
            <span className="chapter-summary-empty">No scene summary yet</span>
          )}
        </p>
      )}
      {/* A chapter card names the cast whose snapshot applies there. The badge is
          a real button, so the hover title works with a keyboard too, and the
          help dot says where the list comes from: two places on the chapter, not
          one. The Cast button opens the roster on the card face. */}
      {kind === 'chapter' && (
        <div className="graph-node-chapter-cast-row">
          {chapterCast.length > 0 ? (
            <div
              className="graph-node-chapter-cast"
              role="group"
              aria-label="Cast in this chapter"
            >
              {chapterCast.map(member => (
                <button
                  type="button"
                  key={member.characterId}
                  className="graph-node-chapter-cast-badge nodrag nopan"
                  data-chapter-cast={member.characterId}
                  title={`${member.name} — ${castLevelText(member)}\nActive skills: ${castSkillText(
                    member
                  )}\nOpen ${member.name}'s sheet`}
                  aria-label={`${member.name}, ${castLevelText(
                    member
                  )}. Active skills: ${castSkillText(member)}`}
                  onClick={event => {
                    event.stopPropagation();
                    data.onOpenChapterCast?.(member.characterId);
                  }}
                >
                  <span className="graph-node-chapter-cast-name">{member.name}</span>
                  {member.level !== null && (
                    <span
                      className={`graph-node-chapter-cast-level${
                        member.levelIsPenalty ? ' penalty' : ''
                      }`}
                    >
                      Lv {member.level}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <span className="graph-node-cast-empty">Nobody in this scene yet</span>
          )}
          <button
            type="button"
            className={`chapter-face-open nodrag nopan${face === 'cast' ? ' active' : ''}`}
            aria-expanded={face === 'cast'}
            title="Choose this chapter’s point of view and who else is in the scene"
            onClick={event => {
              event.stopPropagation();
              setFace(current => (current === 'cast' ? null : 'cast'));
            }}
          >
            Cast
          </button>
          <span className="nodrag nopan">
            <HelpTip label="the cast on a chapter card">
              This is who the story has in this chapter. Two things put a name
              here: the chapter's point of view, and anyone ticked under
              “Present in this chapter” — from the Cast button on this card, or
              on the Chapters tab — so a party shares a scene without anyone
              being bound to the card twice. The level beside a name is the level
              they had as of this chapter, not their latest one, and the hover
              title lists the skills they had then. Click a name to open that
              sheet as of this chapter, or Cast to change the roster here.
            </HelpTip>
          </span>
        </div>
      )}
      {kind === 'chapter' && face === 'cast' && (
        <div
          className="chapter-popover nodrag nopan"
          role="group"
          aria-label={`Who is in ${data.label}`}
        >
          <label className="chapter-popover-row">
            <span>Point of view</span>
            <select
              className="nodrag nopan"
              aria-label={`Point of view of ${data.label}`}
              value={data.chapterPov ?? ''}
              onMouseDown={event => event.stopPropagation()}
              onClick={event => event.stopPropagation()}
              onChange={event =>
                data.onSetChapterPov?.(event.target.value || null)
              }
            >
              <option value="">Nobody yet</option>
              {castChoices.map(choice => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </select>
          </label>

          {castChoices.length === 0 ? (
            <p className="chapter-popover-empty">
              Add someone on the Characters tab first.
            </p>
          ) : (
            <ul className="chapter-popover-cast">
              {castChoices.map(choice => {
                const present = chapterCast.some(
                  member => member.characterId === choice.id
                );
                const isPov = data.chapterPov === choice.id;

                return (
                  <li key={choice.id}>
                    <label className="chapter-popover-cast-row">
                      <input
                        type="checkbox"
                        className="nodrag nopan"
                        checked={present}
                        disabled={isPov}
                        aria-label={`${choice.name} present in ${data.label}`}
                        onClick={event => event.stopPropagation()}
                        onChange={event => {
                          if (event.target.checked) {
                            data.onAddChapterCast?.(choice.id);
                          } else {
                            data.onRemoveChapterCast?.(choice.id);
                          }
                        }}
                      />
                      <span className="chapter-popover-cast-name">
                        {choice.name}
                      </span>
                      {isPov && <span className="chapter-cast-tag">POV</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="chapter-popover-hint">
            The point of view is always present. A tick changes the whole story,
            and Undo takes it back.
          </p>

          <div className="chapter-popover-actions">
            <button
              type="button"
              className="chapter-popover-done nodrag nopan"
              onClick={event => {
                event.stopPropagation();
                setFace(null);
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
      {/* The scene's checklist. Every tick is one undo step, and the lines keep
          the order they were written in. */}
      {kind === 'chapter' && (
        <div
          className="chapter-objectives"
          role="group"
          aria-label={`Objectives in ${data.label}`}
        >
          <div className="chapter-objectives-head">
            <span className="chapter-objectives-title">Objectives</span>
            {objectives.length > 0 && (
              <span className="chapter-objectives-count">
                {doneObjectives}/{objectives.length}
              </span>
            )}
          </div>

          {objectives.length === 0 ? (
            <p className="chapter-objectives-empty">
              Nothing planned yet — add the scene’s first line.
            </p>
          ) : (
            <ul className="chapter-objectives-list">
              {objectives.map(task => (
                <li
                  key={task.id}
                  className={`chapter-objective${task.done ? ' done' : ''}`}
                >
                  <label className="chapter-objective-row">
                    <input
                      type="checkbox"
                      className="nodrag nopan"
                      checked={task.done}
                      aria-label={`${task.text} — ${task.done ? 'done' : 'open'}`}
                      onClick={event => event.stopPropagation()}
                      onChange={() => data.onToggleChapterObjective?.(task)}
                    />
                    <span className="chapter-objective-text">{task.text}</span>
                  </label>
                  <button
                    type="button"
                    className="chapter-objective-remove nodrag nopan"
                    title={`Drop “${task.text}”`}
                    aria-label={`Drop the objective: ${task.text}`}
                    onClick={event => {
                      event.stopPropagation();
                      data.onRemoveChapterObjective?.(task);
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="chapter-objective-add nodrag nopan">
            <input
              className="nodrag nopan"
              type="text"
              aria-label={`Add an objective to ${data.label}`}
              placeholder="Add an objective…"
              value={objectiveDraft}
              onMouseDown={event => event.stopPropagation()}
              onClick={event => event.stopPropagation()}
              onChange={event => setObjectiveDraft(event.target.value)}
              onKeyDown={event => {
                event.stopPropagation();
                if (event.key === 'Enter') void submitObjective();
                if (event.key === 'Escape') setObjectiveDraft('');
              }}
            />
            <button
              type="button"
              className="nodrag nopan"
              disabled={!objectiveDraft.trim()}
              onClick={() => void submitObjective()}
            >
              Add
            </button>
          </div>
        </div>
      )}
      {/* The scene's progression ledger: one row per event, in the order it was
          logged. XP, learned skills and acquired items also touch the sheet;
          rank-ups, evolutions and sacrifices are the scene's record. */}
      {kind === 'chapter' && (
        <div
          className="chapter-events"
          role="group"
          aria-label={`Progression and events in ${data.label}`}
        >
          <div className="chapter-events-head">
            <span className="chapter-events-title">Progression &amp; Events</span>
            {castChoices.length > 0 && (
              <button
                type="button"
                className={`chapter-face-open nodrag nopan${
                  face === 'event' ? ' active' : ''
                }`}
                aria-expanded={face === 'event'}
                title="Log XP, a learned skill, a rank-up, an evolution, a sacrifice or an item"
                onClick={event => {
                  event.stopPropagation();
                  setEventError(null);
                  setFace(current => (current === 'event' ? null : 'event'));
                }}
              >
                + Event
              </button>
            )}
          </div>

          {events.length === 0 ? (
            <p className="chapter-events-empty">
              Nothing has happened here yet — log the scene’s first event.
            </p>
          ) : (
            <ul className="chapter-events-list">
              {events.map(row => (
                <li key={row.id} className={`chapter-event ${row.event_type}`}>
                  <span className="chapter-event-icon" aria-hidden="true">
                    {eventIcon(row.event_type)}
                  </span>
                  <span className="chapter-event-who">{row.actorName}</span>
                  <span className="chapter-event-what">{eventWhat(row)}</span>
                  {row.event_type === 'xp_award' && row.details && (
                    <span className="chapter-event-note">{row.details}</span>
                  )}
                  <button
                    type="button"
                    className="chapter-event-remove nodrag nopan"
                    title={`Remove “${eventWhat(row)}”`}
                    aria-label={`Remove the event: ${eventWhat(row)}`}
                    onClick={event => {
                      event.stopPropagation();
                      data.onDeleteChapterEvent?.(row);
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {kind === 'chapter' && face === 'event' && (
        <div
          className="chapter-popover chapter-event-form nodrag nopan"
          role="group"
          aria-label={`Log an event in ${data.label}`}
        >
          <label className="chapter-popover-row">
            <span>Who</span>
            <select
              className="nodrag nopan"
              aria-label={`Who the event happens to in ${data.label}`}
              value={eventTarget}
              onMouseDown={event => event.stopPropagation()}
              onClick={event => event.stopPropagation()}
              onChange={event => setEventActorId(event.target.value)}
            >
              {castChoices.map(choice => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </select>
          </label>
          <label className="chapter-popover-row">
            <span>Event</span>
            <select
              className="nodrag nopan"
              aria-label={`Event type in ${data.label}`}
              value={eventType}
              onMouseDown={event => event.stopPropagation()}
              onClick={event => event.stopPropagation()}
              onChange={event =>
                chooseEventType(event.target.value as ChapterEventType)
              }
            >
              <option value="xp_award">+ XP</option>
              <option value="skill_learn">Learn Skill</option>
              <option value="skill_rank_up">Rank Up</option>
              <option value="skill_evolve">Evolve</option>
              <option value="skill_sacrifice">Sacrifice</option>
              <option value="item_acquire">Acquire Item</option>
            </select>
          </label>

          {skillEvent && (
            <label className="chapter-popover-row">
              <span>Skill</span>
              <select
                className="nodrag nopan"
                aria-label={`Skill the event changes in ${data.label}`}
                value={chosenSkillId}
                onMouseDown={event => event.stopPropagation()}
                onClick={event => event.stopPropagation()}
                onChange={event => setEventSkillId(event.target.value)}
              >
                {actorSkills.length === 0 && (
                  <option value="">No skills yet</option>
                )}
                {actorSkills.map(skill => (
                  <option key={skill.id} value={skill.id}>
                    {skill.rank ? `${skill.name} (${skill.rank})` : skill.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {eventType === 'skill_rank_up' && chosenSkill && (
            <p className="chapter-popover-hint">
              {chosenSkill.rank
                ? `${chosenSkill.name} rises from ${chosenSkill.rank}.`
                : `${chosenSkill.name} reaches its first rank.`}
            </p>
          )}

          {eventType === 'xp_award' ? (
            <label className="chapter-popover-row">
              <span>XP</span>
              <input
                className="nodrag nopan"
                type="number"
                min={1}
                step={1}
                aria-label={`XP to award in ${data.label}`}
                placeholder="200"
                value={eventAmount}
                onMouseDown={event => event.stopPropagation()}
                onClick={event => event.stopPropagation()}
                onChange={event => setEventAmount(event.target.value)}
                onKeyDown={event => {
                  event.stopPropagation();
                  if (event.key === 'Enter') void submitEvent();
                  if (event.key === 'Escape') {
                    setEventAmount('');
                    setEventDetails('');
                    setEventError(null);
                    setFace(null);
                  }
                }}
              />
            </label>
          ) : eventType === 'skill_rank_up' || eventType === 'skill_sacrifice' ? null : (
            <label className="chapter-popover-row">
              <span>
                {eventType === 'item_acquire'
                  ? 'Item'
                  : eventType === 'skill_learn'
                    ? 'Skill'
                    : 'Evolves into'}
              </span>
              <input
                className="nodrag nopan"
                type="text"
                aria-label={`Detail of the event in ${data.label}`}
                placeholder={
                  eventType === 'item_acquire'
                    ? 'Stolen Ember'
                    : eventType === 'skill_learn'
                      ? 'Ember Whisper'
                      : 'Cinder Step'
                }
                value={eventDetails}
                onMouseDown={event => event.stopPropagation()}
                onClick={event => event.stopPropagation()}
                onChange={event => setEventDetails(event.target.value)}
                onKeyDown={event => {
                  event.stopPropagation();
                  if (event.key === 'Enter') void submitEvent();
                  if (event.key === 'Escape') {
                    setEventAmount('');
                    setEventDetails('');
                    setEventError(null);
                    setFace(null);
                  }
                }}
              />
            </label>
          )}

          {eventType === 'skill_evolve' && (
            <label className="chapter-popover-toggle">
              <input
                className="nodrag nopan"
                type="checkbox"
                aria-label={`Keep the base skill in ${data.label}`}
                checked={keepBaseSkill}
                onMouseDown={event => event.stopPropagation()}
                onClick={event => event.stopPropagation()}
                onChange={event => setKeepBaseSkill(event.target.checked)}
              />
              <span>Keep the base skill</span>
            </label>
          )}

          {eventType === 'skill_sacrifice' && (
            <label className="chapter-popover-toggle">
              <input
                className="nodrag nopan"
                type="checkbox"
                aria-label={`Keep the sacrificed skill in ${data.label}`}
                checked={keepOnSheet}
                onMouseDown={event => event.stopPropagation()}
                onClick={event => event.stopPropagation()}
                onChange={event => setKeepOnSheet(event.target.checked)}
              />
              <span>Keep as a sacrificed record</span>
            </label>
          )}

          {eventType === 'item_acquire' && (
            <label className="chapter-popover-row">
              <span>Qty</span>
              <input
                className="nodrag nopan"
                type="number"
                min={1}
                step={1}
                aria-label={`Quantity in ${data.label}`}
                value={eventAmount}
                onMouseDown={event => event.stopPropagation()}
                onClick={event => event.stopPropagation()}
                onChange={event => setEventAmount(event.target.value)}
                onKeyDown={event => {
                  event.stopPropagation();
                  if (event.key === 'Enter') void submitEvent();
                }}
              />
            </label>
          )}

          {eventType === 'xp_award' && (
            <label className="chapter-popover-row">
              <span>Why</span>
              <input
                className="nodrag nopan"
                type="text"
                aria-label={`Why the XP was awarded in ${data.label}`}
                placeholder="Why this XP"
                value={eventDetails}
                onMouseDown={event => event.stopPropagation()}
                onClick={event => event.stopPropagation()}
                onChange={event => setEventDetails(event.target.value)}
                onKeyDown={event => {
                  event.stopPropagation();
                  if (event.key === 'Enter') void submitEvent();
                  if (event.key === 'Escape') {
                    setEventAmount('');
                    setEventDetails('');
                    setEventError(null);
                    setFace(null);
                  }
                }}
              />
            </label>
          )}

          {eventError && (
            <p className="chapter-event-error" role="alert">
              {eventError}
            </p>
          )}
          <div className="chapter-award-actions">
            <button
              type="button"
              className="nodrag nopan"
              disabled={!eventTarget}
              onClick={() => void submitEvent()}
            >
              Save
            </button>
            <button
              type="button"
              className="nodrag nopan"
              onClick={() => {
                setEventAmount('');
                setEventDetails('');
                setEventError(null);
                setFace(null);
              }}
            >
              Cancel
            </button>
          </div>
          <p className="chapter-popover-hint">
            XP pays into this chapter’s income. A learned skill, a rank-up, an
            evolution and an acquired item are written on the sheet. A sacrifice
            keeps the skill as a record unless you untick it.
          </p>
        </div>
      )}
      {kind === 'chapter' && questBadges.length > 0 && (
        <div
          className="graph-node-quests"
          role="group"
          aria-label="Quests in this chapter"
        >
          {questBadges.slice(0, QUEST_BADGES_SHOWN).map(badge => (
            <button
              type="button"
              key={`${badge.questId}-${badge.role}`}
              className={`graph-node-quest-badge ${badge.role}`}
              data-quest-badge={badge.questId}
              title={`${badge.title} — ${badge.status}, ${
                badge.role === 'accepted' ? 'accepted' : 'ended'
              } in this chapter\nOpen it in the quest ledger`}
              aria-label={`${badge.title}, ${badge.status}, ${
                badge.role === 'accepted' ? 'accepted' : 'ended'
              } here`}
              onClick={event => {
                event.stopPropagation();
                data.onOpenQuest?.(badge.questId);
              }}
            >
              <span className="graph-node-quest-mark" aria-hidden="true">
                {badge.role === 'accepted' ? '◈' : '✓'}
              </span>
              <span className="graph-node-quest-title">{badge.title}</span>
            </button>
          ))}
          {questBadges.length > QUEST_BADGES_SHOWN && (
            <span className="graph-node-quest-more">
              +{questBadges.length - QUEST_BADGES_SHOWN} more
            </span>
          )}
        </div>
      )}
      {kind === 'chapter' && continuityFlags.length > 0 && (
        <div
          className="graph-node-continuity"
          title={continuityFlags.map(flag => flag.detail).join('\n')}
        >
          {continuityFlags.slice(0, 2).map((flag, index) => (
            <div className="graph-node-continuity-line" key={flag.id}>
              <button
                type="button"
                className="graph-node-continuity-open nodrag nopan"
                title={`Open ${flag.characterName}'s sheet\n${flag.detail}`}
                aria-label={`Open ${flag.characterName}'s sheet: ${flag.detail}`}
                onClick={event => {
                  event.stopPropagation();
                  data.onOpenContinuity?.(flag.characterId, flag.target);
                }}
              >
                <span className="graph-node-continuity-mark" aria-hidden="true">
                  !
                </span>
                {flag.summary}
              </button>
              {flag.kind === 'stat-sheet-mismatch' &&
                flag.statName &&
                flag.statValue != null && (
                  <button
                    type="button"
                    className="graph-node-continuity-sync nodrag nopan"
                    title={`Record the level-up's ${flag.statName} of ${flag.statValue} on ${flag.characterName}'s sheet`}
                    disabled={
                      data.syncingStatKey ===
                      `${flag.characterId}::${flag.statName}`
                    }
                    onClick={event => {
                      event.stopPropagation();
                      data.onSyncSheetStat?.(flag);
                    }}
                  >
                    {data.syncingStatKey ===
                    `${flag.characterId}::${flag.statName}`
                      ? 'Syncing…'
                      : `Set to ${flag.statValue}`}
                  </button>
                )}
              {flag.kind === 'xp-income-mismatch' &&
                flag.ledgerXp != null &&
                flag.target.kind === 'level' && (
                  <button
                    type="button"
                    className="graph-node-continuity-sync nodrag nopan"
                    title={`Record the ledger's total of ${formatCount(flag.ledgerXp)} XP on this milestone`}
                    aria-label={`Sync ${flag.characterName}'s total XP to ${formatCount(
                      flag.ledgerXp
                    )} XP`}
                    disabled={data.syncingMilestoneXpId === flag.target.milestoneId}
                    onClick={event => {
                      event.stopPropagation();
                      data.onSyncMilestoneXp?.(flag);
                    }}
                  >
                    {data.syncingMilestoneXpId === flag.target.milestoneId
                      ? 'Syncing…'
                      : `Sync to ${formatCount(flag.ledgerXp)} XP`}
                  </button>
                )}
              {flag.itemId &&
                continuityFlags.findIndex(other => other.itemId === flag.itemId) === index && (

                  <button
                    type="button"
                    className="graph-node-continuity-return nodrag nopan"
                    title={`Clear the lost chapter for “${flag.itemName}” and mark it returned`}
                    aria-label={`Mark ${flag.itemName} returned`}
                    disabled={data.returningItemId === flag.itemId}
                    onClick={event => {
                      event.stopPropagation();
                      data.onMarkItemReturned?.(flag.itemId!);
                    }}
                  >
                    {data.returningItemId === flag.itemId ? 'Returning…' : 'Mark returned'}
                  </button>
                )}
            </div>
          ))}
          {(data.hiddenContinuityFlags ?? 0) > 0 && (
            <span className="graph-node-continuity-more">
              +{data.hiddenContinuityFlags} more
            </span>
          )}
        </div>
      )}
      {/* A chapter's roster is already above as badges, with the same names and
          levels, so the linked-cast footer would only repeat one of them. */}
      {linked && kind !== 'chapter' && (
        <span
          className="graph-node-cast"
          title={
            level !== null || stats.length > 0
              ? [
                  level !== null ? `Level ${level}` : null,
                  ...stats.map(stat => `${stat.stat_name} ${stat.value}`),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined
          }
        >
          {level !== null && (
            <span className="graph-node-level">Lv {level}</span>
          )}
          {data.characterName && data.characterName !== data.label && (
            <span className="graph-node-cast-name">{data.characterName}</span>
          )}
          {shown.map(stat => (
            <span className="graph-node-stat" key={stat.id}>
              {stat.stat_name} {stat.value}
            </span>
          ))}
          {hidden > 0 && <span className="graph-node-stat more">+{hidden}</span>}
          {stats.length === 0 && (
            <span className="graph-node-cast-empty">
              {data.characterName ? 'no stats yet' : 'cast member in the trash'}
            </span>
          )}
        </span>
      )}
      {/* A skill card names who has it, so the board answers "who can do this"
          without opening every character sheet. */}
      {kind === 'skill' && (
        <span
          className="graph-node-holders"
          title={
            holders.length > 0
              ? holders
                  .map(holder =>
                    [
                      holder.characterName,
                      holder.rank,
                      holder.chapterLabel ? `learned in ${holder.chapterLabel}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  )
                  .join('\n')
              : undefined
          }
        >
          {holders.length === 0 && (
            <span className="graph-node-holders-empty">No one has this skill yet</span>
          )}
          {holders.slice(0, 2).map(holder => (
            <span className="graph-node-holder" key={holder.id}>
              <span className="graph-node-holder-name">{holder.characterName}</span>
              {holder.rank && (
                <span className="graph-node-holder-rank">{holder.rank}</span>
              )}
              {holder.chapterLabel && (
                <span
                  className="graph-node-holder-chapter"
                  title={`Learned in ${holder.chapterLabel}`}
                >
                  {holder.chapterLabel}
                </span>
              )}
            </span>
          ))}
          {(data.hiddenSkillHolders ?? 0) > 0 && (
            <span className="graph-node-holder more">
              +{data.hiddenSkillHolders}
            </span>
          )}
        </span>
      )}
      {/* An item card names who carries it, how many and how rare it is, so the
          board answers "who has this" without opening every sheet. */}
      {kind === 'item' && (
        <span
          className="graph-node-holders"
          title={
            itemHolders.length > 0
              ? itemHolders
                  .map(holder =>
                    [
                      holder.characterName,
                      `×${holder.quantity}`,
                      holder.rarity,
                      holder.chapterLabel ? `acquired in ${holder.chapterLabel}` : null,
                      holder.lostChapterLabel ? `lost in ${holder.lostChapterLabel}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  )
                  .join('\n')
              : undefined
          }
        >
          {itemHolders.length === 0 && (
            <span className="graph-node-holders-empty">
              No one is carrying this item yet
            </span>
          )}
          {itemHolders.slice(0, 2).map(holder => (
            <span className="graph-node-holder" key={holder.id}>
              <span className="graph-node-holder-name">{holder.characterName}</span>
              <span className="graph-node-holder-quantity">×{holder.quantity}</span>
              {holder.rarity && (
                <span className="graph-node-holder-rarity">{holder.rarity}</span>
              )}
              {holder.chapterLabel && (
                <span
                  className="graph-node-holder-chapter"
                  title={`Acquired in ${holder.chapterLabel}`}
                >
                  {holder.chapterLabel}
                </span>
              )}
              {holder.lostChapterLabel && (
                <span
                  className="graph-node-holder-lost"
                  title={`Lost in ${holder.lostChapterLabel}`}
                >
                  lost in {holder.lostChapterLabel}
                </span>
              )}
            </span>
          ))}
          {(data.hiddenInventoryHolders ?? 0) > 0 && (
            <span className="graph-node-holder more">
              +{data.hiddenInventoryHolders}
            </span>
          )}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
    </div>

    {/* The notes hang under their chapter like cards pinned to it: context for
        the drawing, not another thing to arrange. */}
    {kind === 'chapter' && data.noteCards && data.noteCards.length > 0 && (
      <div className="graph-node-notes">
        {data.noteCards.map(note => (
          <button
            key={note.id}
            className="graph-node-note nodrag nopan"
            aria-label={`Open the note: ${note.text}`}
            title={`Open this note on the Chapters tab: ${note.text}`}
            onClick={event => {
              event.stopPropagation();
              data.onOpenNote?.(note.id);
            }}
          >
            {note.text}
          </button>
        ))}
        {data.hiddenNotes ? (
          <button
            className="graph-node-note more nodrag nopan"
            title="Open every note kept with this chapter"
            onClick={event => {
              event.stopPropagation();
              data.onOpenNote?.(null);
            }}
          >
            +{data.hiddenNotes} more{' '}
            {data.hiddenNotes === 1 ? 'note' : 'notes'}
          </button>
        ) : null}
      </div>
    )}
    </>
  );
}

// Defined once: React Flow re-creates every node when this object changes.
export const flowNodeTypes = { default: GraphNode };
