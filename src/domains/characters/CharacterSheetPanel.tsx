import React from 'react';
import { CharacterViewToggle } from '../../components/CharacterViewToggle';
import type { ChapterNode } from '../narrative/chapters';
import type { CharacterChapterState } from '../narrative/types';
import { ChapterSnapshot } from '../progression/ChapterSnapshot';
import { ProgressionChart } from '../progression/ProgressionChart';
import type { ProgressionChartSeries, ProgressionMetric } from '../progression/types';
import type { Character, CharacterStat } from '../shared/types';
import type { Story } from '../stories/types';

// The shell of the Characters tab: the switch between its three views, the story
// guard, the power curve with its controls and chapter readout, the cast rail with
// its creator, and the header of the selected sheet. What the sheet puts under
// that header - progression, milestones, income, attributes, skills, inventory,
// currency, relations and standings - arrives as children while those sections
// move here, so this file owns the parts that read only the chart and the cast.
//
// Every answer it shows is worked out in the app from the story-wide reads the
// board, the chart and the sheets share, and arrives as a prop. The drafts behind
// the creator and the name editor stay in the app with the writes they feed, so a
// create, a save and a delete are still one audited action each.

export type CharacterView = 'sheet' | 'relations' | 'skills';

export interface CharacterSheetPanelProps {
  story: Story | null;
  onViewChange: (view: CharacterView) => void;
  characterError: string | null;

  // The power curve, its metric, and the chapter its readout is asked about.
  chapterNodes: ChapterNode[];
  chartMetric: ProgressionMetric;
  setChartMetric: (metric: ProgressionMetric) => void;
  chartStatName: string;
  setChartStatName: (name: string) => void;
  statNameOptions: string[];
  chartSeries: ProgressionChartSeries[];
  chartMetricSeries: ProgressionChartSeries[];
  visibleChartSeries: ProgressionChartSeries[];
  chartMilestoneSeries: ProgressionChartSeries[];
  hiddenChartCharacterIds: string[];
  toggleChartCharacter: (characterId: string) => void;
  chartStateChapterId: string;
  setChartStateChapterId: (chapterId: string) => void;
  chartStateChapters: ChapterNode[];
  chartStateChapter: ChapterNode | null;
  chartStateLoading: boolean;
  chartStateError: string | null;
  chartStateById: Map<string, CharacterChapterState>;
  visibleComparisonSeries: ProgressionChartSeries[];
  // The stats each sheet holds now, so the expanded readout can show what a
  // number became rather than only what it was.
  castStats: Record<string, CharacterStat[]>;
  // A chapter card's badge asks for one sheet as it stood in that chapter. The
  // request carries a counter, so clicking the same badge twice asks again.
  chapterStateFocus: {
    characterId: string;
    chapterId: string;
    request: number;
  } | null;

  // The cast rail, and the two fields that add to it.
  characters: Character[];
  selectedCharacterId: string | null;
  setSelectedCharacterId: (characterId: string) => void;
  newCharacterName: string;
  setNewCharacterName: (name: string) => void;
  newCharacterDescription: string;
  setNewCharacterDescription: (description: string) => void;
  createCharacter: () => Promise<void>;

  // The selected sheet's header, and the edit and delete it offers.
  selectedCharacter: Character | null;
  editingCharacter: boolean;
  setEditingCharacter: (editing: boolean) => void;
  characterNameDraft: string;
  setCharacterNameDraft: (name: string) => void;
  characterDescriptionDraft: string;
  setCharacterDescriptionDraft: (description: string) => void;
  saveCharacter: () => Promise<void>;
  startCharacterEdit: () => void;
  confirmDeleteCharacter: boolean;
  setConfirmDeleteCharacter: (confirming: boolean) => void;
  removeCharacter: () => Promise<void>;

  // The sheet's remaining sections, still rendered by the app for now.
  children: React.ReactNode;
}

export function CharacterSheetPanel({
  story,
  onViewChange,
  characterError,
  chapterNodes,
  chartMetric,
  setChartMetric,
  chartStatName,
  setChartStatName,
  statNameOptions,
  chartSeries,
  chartMetricSeries,
  visibleChartSeries,
  chartMilestoneSeries,
  hiddenChartCharacterIds,
  toggleChartCharacter,
  chartStateChapterId,
  setChartStateChapterId,
  chartStateChapters,
  chartStateChapter,
  chartStateLoading,
  chartStateError,
  chartStateById,
  visibleComparisonSeries,
  castStats,
  chapterStateFocus,
  characters,
  selectedCharacterId,
  setSelectedCharacterId,
  newCharacterName,
  setNewCharacterName,
  newCharacterDescription,
  setNewCharacterDescription,
  createCharacter,
  selectedCharacter,
  editingCharacter,
  setEditingCharacter,
  characterNameDraft,
  setCharacterNameDraft,
  characterDescriptionDraft,
  setCharacterDescriptionDraft,
  saveCharacter,
  startCharacterEdit,
  confirmDeleteCharacter,
  setConfirmDeleteCharacter,
  removeCharacter,
  children,
}: CharacterSheetPanelProps) {
  // Which cast member's whole sheet is open under the chapter readout. One at a
  // time keeps the panel the height of a comparison rather than a stack.
  const [openSnapshotId, setOpenSnapshotId] = React.useState<string | null>(null);

  // A chapter card's cast badge lands here: the readout moves to that chapter,
  // that character's whole sheet opens under it, and the row is scrolled into
  // view once the panel that draws it exists.
  React.useEffect(() => {
    if (!chapterStateFocus) return;
    if (chapterStateFocus.characterId !== selectedCharacterId) return;

    setChartStateChapterId(chapterStateFocus.chapterId);
    setOpenSnapshotId(chapterStateFocus.characterId);

    const timer = window.setTimeout(() => {
      document
        .querySelector(
          `[data-state-character="${chapterStateFocus.characterId}"]`
        )
        ?.scrollIntoView?.({ block: 'nearest' });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [chapterStateFocus, selectedCharacterId, setChartStateChapterId]);

  return (
    <div className="tab-content">
      <CharacterViewToggle view="sheet" onChange={onViewChange} />
      {!story ? (
        <div className="empty-state">Load a story to manage characters</div>
      ) : (
        <>
          <section className="progression-chart-panel" aria-label="Progression chart">
            <div className="progression-chart-head">
              <div>
                <h3 className="progression-chart-title">Power curve</h3>
                <div className="progression-chart-caption">
                  {chartMetric === 'level'
                    ? 'Level milestones by chapter in reading order.'
                    : chartMetric === 'xp'
                      ? 'Total XP recorded at each level milestone by chapter.'
                      : chartMetric === 'earned'
                        ? 'XP earned in each chapter, shown as one bar per character.'
                        : chartStatName
                          ? `${chartStatName} snapshots recorded at each level milestone.`
                          : 'Choose a numeric stat to plot.'}
                </div>
              </div>

              {chartMetricSeries.length > 0 && (
                <div
                  className="progression-legend"
                  role="group"
                  aria-label="Compare characters"
                >
                  {chartMetricSeries.map(series => {
                    const shown = !hiddenChartCharacterIds.includes(
                      series.characterId
                    );

                    return (
                      <button
                        key={series.characterId}
                        className={`progression-legend-button ${
                          shown ? 'active' : ''
                        }`}
                        aria-pressed={shown}
                        title={`${shown ? 'Hide' : 'Show'} ${series.name}'s ${
                          chartMetric === 'earned' ? 'XP bars' : 'line'
                        }`}
                        onClick={() => toggleChartCharacter(series.characterId)}
                      >
                        <span
                          className="progression-legend-swatch"
                          style={{ backgroundColor: series.color }}
                          aria-hidden="true"
                        />
                        {series.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="progression-chart-controls">
              <span className="progression-chart-controls-label">Y-axis</span>
              <div
                className="progression-metric-toggle"
                role="group"
                aria-label="Chart metric"
              >
                {(
                  [
                    ['level', 'Level'],
                    ['xp', 'Total XP'],
                    ['earned', 'XP earned'],
                    ['stat', 'Stats'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={`progression-metric-button ${
                      chartMetric === value ? 'active' : ''
                    }`}
                    aria-pressed={chartMetric === value}
                    onClick={() => setChartMetric(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {chartMetric === 'stat' &&
                (statNameOptions.length > 0 ? (
                  <label className="progression-stat-picker">
                    <span>Stat</span>
                    <select
                      aria-label="Stat to plot"
                      value={chartStatName}
                      onChange={e => setChartStatName(e.target.value)}
                    >
                      {statNameOptions.map(name => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="progression-chart-controls-note">
                    No numeric stats yet.
                  </span>
                ))}
            </div>

            {chapterNodes.length === 0 ? (
              <div className="empty">
                Add a chapter before plotting a power curve.
              </div>
            ) : chartSeries.length === 0 ? (
              <div className="empty">
                No progression recorded yet — add a level milestone or XP earned on a
                character's sheet.
              </div>
            ) : chartMetricSeries.length === 0 ? (
              <div className="empty">
                {chartMetric === 'level'
                  ? 'No levels yet — record XP on a character\'s sheet.'
                  : chartMetric === 'xp'
                    ? 'No levels yet — record XP on a character\'s sheet.'
                    : chartMetric === 'earned'
                      ? 'No XP earned by chapter yet — record it on a character\'s sheet.'
                      : chartStatName
                        ? `No ${chartStatName} snapshots yet — record one on a level milestone.`
                        : 'No numeric stats yet — add a stat on a character\'s sheet first.'}
              </div>
            ) : visibleChartSeries.length === 0 ? (
              <div className="empty">
                {chartMetric === 'level'
                  ? 'Choose a character above to show a level line.'
                  : chartMetric === 'earned'
                    ? 'Choose a character above to show its XP bars.'
                    : 'Choose a character above to show a line.'}
              </div>
            ) : (
              <ProgressionChart
                chapters={chapterNodes}
                series={visibleChartSeries}
                metric={chartMetric}
                statName={chartStatName}
              />
            )}

            {chartMilestoneSeries.length > 0 && chartStateChapters.length > 0 && (
              <div className="progression-chapter-state">
                <label className="progression-state-picker">
                  <span>As of chapter</span>
                  <select
                    aria-label="Chapter state"
                    title="Read each selected character's level and skills at this chapter"
                    value={chartStateChapterId}
                    onChange={(e) => setChartStateChapterId(e.target.value)}
                  >
                    {chartStateChapters.map(chapter => (
                      <option key={chapter.id} value={chapter.id}>
                        {`Ch. ${chapter.data.chapterSeq} — ${chapter.data.label}`}
                      </option>
                    ))}
                  </select>
                </label>

                {visibleComparisonSeries.length === 0 ? (
                  <div className="progression-state-note">
                    Choose a character to read a chapter state.
                  </div>
                ) : chartStateLoading ? (
                  <div className="progression-state-note" role="status">
                    Reading chapter state…
                  </div>
                ) : chartStateError ? (
                  <div className="audit-error">
                    Could not read chapter state: {chartStateError}
                  </div>
                ) : (
                  <ul
                    className="progression-state-list"
                    aria-label={`Character state at ${
                      chartStateChapter?.data.label ?? 'chapter'
                    }`}
                  >
                    {visibleComparisonSeries.map(series => {
                      const state = chartStateById.get(series.characterId);
                      const skills = state?.skills ?? [];
                      const open = openSnapshotId === series.characterId;
                      const chapterLabel =
                        chartStateChapter?.data.label ?? 'this chapter';

                      return (
                        <li
                          key={series.characterId}
                          data-state-character={series.characterId}
                          className={`progression-state-item ${
                            open ? 'open' : ''
                          }`}
                        >
                          <span
                            className="progression-legend-swatch"
                            style={{ backgroundColor: series.color }}
                            aria-hidden="true"
                          />
                          <span className="progression-state-name">
                            {series.name}
                          </span>
                          <span className="progression-state-level">
                            {state?.level != null
                              ? `Level ${state.level}${
                                  state.level_is_penalty ? ' (penalty)' : ''
                                }`
                              : 'No level recorded'}
                          </span>
                          <span className="progression-state-skills">
                            {skills.length === 0
                              ? 'No active skills'
                              : skills
                                  .map(skill =>
                                    skill.rank
                                      ? `${skill.name} (${skill.rank})`
                                      : skill.name
                                  )
                                  .join(' · ')}
                          </span>
                          <button
                            type="button"
                            className="progression-state-open"
                            aria-expanded={open}
                            aria-controls={`chapter-snapshot-${series.characterId}`}
                            disabled={!state}
                            title={
                              open
                                ? `Close ${series.name}'s sheet at ${chapterLabel}`
                                : `Read ${series.name}'s whole sheet — stats, skills and what they carried — as of ${chapterLabel}`
                            }
                            onClick={() =>
                              setOpenSnapshotId(open ? null : series.characterId)
                            }
                          >
                            {open ? 'Hide sheet' : 'Read sheet'}
                          </button>

                          {open && state && (
                            <div
                              id={`chapter-snapshot-${series.characterId}`}
                              className="progression-state-detail"
                            >
                              <ChapterSnapshot
                                state={state}
                                characterName={series.name}
                                chapterLabel={chapterLabel}
                                stats={castStats[series.characterId] ?? []}
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>

          <div className="characters-layout">
          <div className="character-list">
            <div className="character-creator">
              <input
                placeholder="Character name"
                value={newCharacterName}
                onChange={(e) => setNewCharacterName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createCharacter()}
              />
              <input
                placeholder="Description (optional)"
                value={newCharacterDescription}
                onChange={(e) => setNewCharacterDescription(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createCharacter()}
              />
              <button
                title="Add this character to the story's cast"
                onClick={createCharacter}
                disabled={!newCharacterName.trim()}
              >
                Add character
              </button>
            </div>

            {characters.length === 0 && <div className="empty">No characters yet</div>}

            {characters.map(character => (
              <div
                key={character.id}
                data-character-id={character.id}
                className={`character-item ${
                  selectedCharacterId === character.id ? 'active' : ''
                }`}
                title={`Show ${character.name}'s sheet`}
                // The sheet's own panels hold their forms, and each closes its
                // editor when the character it was opened for is no longer the
                // one selected, so the rail only has to choose.
                onClick={() => setSelectedCharacterId(character.id)}
              >
                <span className="character-name">{character.name}</span>
                <span className="character-level">
                  Level {character.level ?? 1}
                  {character.rank ? ` · ${character.rank}` : ''}
                </span>
                {character.description && (
                  <span className="character-description">{character.description}</span>
                )}
              </div>
            ))}
          </div>

          <div className="character-detail">
            {characterError && <div className="audit-error">{characterError}</div>}

            {!selectedCharacterId ? (
              <div className="empty">Select or create a character</div>
            ) : (
              <>
                <div className="character-header">
                  {editingCharacter ? (
                    <div className="character-editor">
                      <input
                        className="character-name-input"
                        autoFocus
                        value={characterNameDraft}
                        onChange={(e) => setCharacterNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveCharacter();
                          if (e.key === 'Escape') setEditingCharacter(false);
                        }}
                      />
                      <input
                        placeholder="Description (optional)"
                        value={characterDescriptionDraft}
                        onChange={(e) => setCharacterDescriptionDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveCharacter();
                          if (e.key === 'Escape') setEditingCharacter(false);
                        }}
                      />
                      <button
                        title="Save this character's name and description"
                        onClick={saveCharacter}
                        disabled={!characterNameDraft.trim()}
                      >
                        Save
                      </button>
                      <button
                        title="Discard the edit"
                        onClick={() => setEditingCharacter(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="character-title">
                        <h3 className="character-heading">
                          {selectedCharacter?.name ?? 'Character'}
                        </h3>
                        {selectedCharacter?.description && (
                          <div className="character-subheading">
                            {selectedCharacter.description}
                          </div>
                        )}
                      </div>
                      <div className="character-actions">
                        {confirmDeleteCharacter ? (
                          <>
                            <button
                              className="danger"
                              title="Move this character to the trash; linked nodes keep their links"
                              onClick={removeCharacter}
                            >
                              Delete
                            </button>
                            <button
                              title="Keep this character"
                              onClick={() => setConfirmDeleteCharacter(false)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              title="Change this character's name or description"
                              onClick={startCharacterEdit}
                            >
                              Edit
                            </button>
                            <button
                              title="Delete character"
                              onClick={() => setConfirmDeleteCharacter(true)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {children}
              </>
            )}
          </div>
          </div>
        </>
      )}
    </div>
  );
}
