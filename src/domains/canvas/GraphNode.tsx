import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { formatCount } from '../../lib/format';
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
    <div className={`graph-node ${kind}`}>
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
          a real button, so the hover title works with a keyboard too. */}
      {kind === 'chapter' && chapterCast.length > 0 && (
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
      {linked && (
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
