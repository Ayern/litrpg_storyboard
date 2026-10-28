import type { CharacterChapterState } from '../narrative/types';
import type { CharacterStat } from '../shared/types';

// The whole sheet as it stood at one chapter: the level recorded by then, the
// stats the level-ups had given numbers to, the skills learned and not yet
// sacrificed, and the items gained and not yet lost.
//
// Every "then" value comes from the snapshot the database works out from the
// ledgers. The sheet's rows today arrive beside it only so a difference can be
// shown — a stat that has moved since, or one that has left the sheet — never
// to fill in a value the story has not recorded. A stat with no value by that
// chapter is shown as a name and nothing else, because a missing number is a
// gap in the ledger, not a zero.
export function ChapterSnapshot({
  state,
  characterName,
  chapterLabel,
  stats,
}: {
  state: CharacterChapterState;
  characterName: string;
  chapterLabel: string;
  // The stat rows on the sheet now, for the "now" beside a "then". The items
  // need no such list: the snapshot already chose them and carries their
  // quantity.
  stats: CharacterStat[];
}) {
  const statRows = state.stats ?? [];
  const skillRows = state.skills ?? [];
  const itemRows = state.items ?? [];
  const undatedItems = state.undated_items ?? 0;

  // Today's values, keyed by name, so a stat can show what it became.
  const todayByName = new Map(stats.map(stat => [stat.stat_name, stat.value]));

  return (
    <section
      className="chapter-snapshot"
      aria-label={`${characterName}'s sheet at ${chapterLabel}`}
    >
      <div className="chapter-snapshot-head">
        <span className="chapter-snapshot-level">
          {state.level != null
            ? `Level ${state.level}${state.level_is_penalty ? ' (penalty)' : ''}`
            : 'No level recorded by this chapter'}
          {state.level_chapter_seq != null
            ? ` · recorded in Ch. ${state.level_chapter_seq}`
            : ''}
        </span>
      </div>

      <div className="chapter-snapshot-block">
        <h4 className="chapter-snapshot-heading">Stats</h4>
        {statRows.length === 0 ? (
          <p className="chapter-snapshot-empty">No stats by this chapter.</p>
        ) : (
          <ul className="chapter-snapshot-list" aria-label="Stats as of this chapter">
            {statRows.map(stat => {
              const now = todayByName.get(stat.stat_name);
              const stillOnSheet = now !== undefined;

              return (
                <li
                  key={stat.stat_name}
                  className="chapter-snapshot-row"
                  data-snapshot-stat={stat.stat_name}
                >
                  <span className="chapter-snapshot-name">{stat.stat_name}</span>
                  <span className="chapter-snapshot-value">
                    {stat.value ?? '—'}
                  </span>
                  <span className="chapter-snapshot-origin">
                    {stat.recorded_chapter_seq != null
                      ? `Ch. ${stat.recorded_chapter_seq}`
                      : 'no value yet'}
                  </span>
                  {!stillOnSheet ? (
                    <span className="chapter-snapshot-now">
                      not on the sheet now
                    </span>
                  ) : now !== stat.value ? (
                    <span className="chapter-snapshot-now">now {now}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="chapter-snapshot-block">
        <h4 className="chapter-snapshot-heading">Skills</h4>
        {skillRows.length === 0 ? (
          <p className="chapter-snapshot-empty">No skills learned by this chapter.</p>
        ) : (
          <ul className="chapter-snapshot-list" aria-label="Skills as of this chapter">
            {skillRows.map(skill => (
              <li
                key={skill.skill_id}
                className="chapter-snapshot-row"
                data-snapshot-skill={skill.name}
              >
                <span className="chapter-snapshot-name">{skill.name}</span>
                {skill.rank && (
                  <span className="chapter-snapshot-rank">{skill.rank}</span>
                )}
                <span className="chapter-snapshot-origin">
                  learned in Ch. {skill.learned_chapter_seq}
                </span>
                {skill.effect && (
                  <span className="chapter-snapshot-note">{skill.effect}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="chapter-snapshot-block">
        <h4 className="chapter-snapshot-heading">Inventory</h4>
        {itemRows.length === 0 ? (
          <p className="chapter-snapshot-empty">
            Nothing recorded as carried by this chapter.
          </p>
        ) : (
          <>
            <ul
              className="chapter-snapshot-list"
              aria-label="Items carried at this chapter"
            >
              {itemRows.map(item => (
                <li
                  key={item.item_id}
                  className="chapter-snapshot-row"
                  data-snapshot-item={item.name}
                >
                  <span className="chapter-snapshot-name">
                    {item.quantity > 1
                      ? `${item.name} ×${item.quantity}`
                      : item.name}
                  </span>
                  {item.rarity && (
                    <span className="chapter-snapshot-rank">{item.rarity}</span>
                  )}
                  <span className="chapter-snapshot-origin">
                    gained in Ch. {item.acquired_chapter_seq}
                  </span>
                  {item.effect && (
                    <span className="chapter-snapshot-note">{item.effect}</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="chapter-snapshot-caption">
              Quantities are the sheet's now; a chapter only says when an item
              was gained or lost.
            </p>
          </>
        )}

        {undatedItems > 0 && (
          <p className="chapter-snapshot-empty">
            {undatedItems === 1
              ? 'One more item has no chapter, so it cannot be placed in the story.'
              : `${undatedItems} more items have no chapter, so they cannot be placed in the story.`}
          </p>
        )}
      </div>
    </section>
  );
}
