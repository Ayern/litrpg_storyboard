import { useEffect, useMemo, useState } from 'react';
import type { ChapterNode } from '../narrative/chapters';
import type { CharacterChapterState } from '../narrative/types';
import type { CharacterSkillEvent } from '../skills/types';
import type {
  Character,
  CharacterLevelMilestone,
  CharacterProgress,
  CharacterStat,
  LevelGrowthRule,
} from '../shared/types';
import * as progressionApi from './api';
import { chartSeriesFor, metricSeriesFor, statNamesFrom } from './chart';
import { crossingMilestones } from './crossings';
import type { ProgressionMetric } from './types';

// The progression chart's own state: which metric its lines are read in, which
// stat a "stat" line follows, which cast members are hidden from the comparison,
// and the snapshot of one chapter's level and skills.
//
// The story's rows arrive as arguments, because the chart and the sheets read
// the same ledgers; the one thing it asks the database for is the chapter
// snapshot, which is worked out there rather than recalculated here. The sheet's
// jump target — the row a warning just opened — belongs to the sheet, so it
// stays with the app.

export interface ProgressionChartOptions {
  characters: Character[];
  milestones: CharacterLevelMilestone[];
  progress: CharacterProgress[];
  // The chapters, so a point is only placed on one that is still on the board.
  chapterNodes: ChapterNode[];
  // The stats the sheets hold now, which is where a stat line gets its names.
  castStats: Record<string, CharacterStat[]>;
  // The story's rules, so a level line is drawn on the step the story levels on
  // rather than on whatever a row happens to say.
  growthRules: LevelGrowthRule[];
  // The sheet is on screen. While another tab is showing, the readout has no
  // reader, so nothing is asked of the database and what was read is dropped.
  active: boolean;
  storyId: string | null;
  // A skill edit changes what a chapter held, so the readout reads again. The
  // rows themselves are the sheet's; only the fact that they moved is the
  // chart's business.
  skillEvents: CharacterSkillEvent[];
}

export function useProgressionChart({
  characters,
  milestones,
  progress,
  chapterNodes,
  castStats,
  growthRules,
  active,
  storyId,
  skillEvents,
}: ProgressionChartOptions) {
  const [chartMetric, setChartMetric] = useState<ProgressionMetric>('level');
  const [chartStatName, setChartStatName] = useState('');

  // The chart compares cast members, so a line is only hidden explicitly rather
  // than being selected on first load.
  const [hiddenChartCharacterIds, setHiddenChartCharacterIds] = useState<string[]>([]);

  // The chapter whose snapshot is shown, and what the database answered.
  const [chartStateChapterId, setChartStateChapterId] = useState('');
  const [chartChapterStates, setChartChapterStates] = useState<CharacterChapterState[]>([]);
  const [chartStateLoading, setChartStateLoading] = useState(false);
  const [chartStateError, setChartStateError] = useState<string | null>(null);

  const statNameOptions = useMemo(
    () => statNamesFrom(castStats, milestones),
    [castStats, milestones]
  );

  useEffect(() => {
    if (chartMetric !== 'stat') return;

    setChartStatName(previous =>
      previous && statNameOptions.includes(previous) ? previous : statNameOptions[0] ?? ''
    );
  }, [chartMetric, statNameOptions]);

  const chartSeries = useMemo(
    () => chartSeriesFor(characters, milestones, progress, chapterNodes, growthRules),
    [characters, milestones, progress, chapterNodes, growthRules]
  );

  const chartMilestoneSeries = useMemo(
    () =>
      chartSeries.filter(
        series => series.crossings.length > 0 || series.milestones.length > 0
      ),
    [chartSeries]
  );

  // A level or XP line is drawn at the curve's crossings; a stat line still needs
  // the recorded snapshot, which only a row has.
  const chartMetricSeries = useMemo(() => {
    const series = metricSeriesFor(chartSeries, chartMetric, chartStatName);

    if (chartMetric === 'stat' || chartMetric === 'earned') return series;

    return series.map(entry => ({
      ...entry,
      milestones: crossingMilestones(entry.characterId, entry.crossings),
    }));
  }, [chartSeries, chartMetric, chartStatName]);

  const visibleComparisonSeries = useMemo(
    () => chartMilestoneSeries.filter(series => !hiddenChartCharacterIds.includes(series.characterId)),
    [chartMilestoneSeries, hiddenChartCharacterIds]
  );

  const visibleChartSeries = useMemo(
    () => chartMetricSeries.filter(series => !hiddenChartCharacterIds.includes(series.characterId)),
    [chartMetricSeries, hiddenChartCharacterIds]
  );

  // The chapter-state request is keyed by ids rather than by the series array.
  // `useMemo` can hand back a fresh array when the board redraws; the ids are what
  // actually change the question being asked of the database. It follows the
  // comparison set, not the metric, so switching to XP does not hide a character
  // from the "as of chapter" readout.
  const visibleChartCharacterIds = visibleComparisonSeries
    .map(series => series.characterId)
    .join('|');

  // A chapter without a reading-order number cannot anchor an "as of" query, so
  // the readout offers only chapters the database can actually place.
  const chartStateChapters = useMemo(
    () => chapterNodes.filter(chapter => chapter.data.chapterSeq != null),
    [chapterNodes]
  );

  const chartStateById = useMemo(
    () => new Map(chartChapterStates.map(state => [state.character_id, state])),
    [chartChapterStates]
  );

  const chartStateChapter =
    chartStateChapters.find(chapter => chapter.id === chartStateChapterId) ?? null;

  useEffect(() => {
    if (!active) return;

    setChartStateChapterId(previous => {
      if (previous && chartStateChapters.some(chapter => chapter.id === previous)) {
        return previous;
      }

      return chartStateChapters[chartStateChapters.length - 1]?.id ?? '';
    });
  }, [active, chartStateChapters]);

  useEffect(() => {
    if (!active || !storyId || !chartStateChapterId || !visibleChartCharacterIds) {
      setChartChapterStates(previous => (previous.length === 0 ? previous : []));
      setChartStateLoading(false);
      setChartStateError(null);
      return;
    }

    let cancelled = false;
    setChartStateLoading(true);
    setChartStateError(null);

    Promise.all(
      visibleChartCharacterIds
        .split('|')
        .map(characterId => progressionApi.getCharacterStateAtChapter(characterId, chartStateChapterId))
    )
      .then(states => {
        if (cancelled) return;
        setChartChapterStates(
          states.filter((state): state is CharacterChapterState => Boolean(state))
        );
      })
      .catch(error => {
        if (cancelled) return;
        setChartChapterStates([]);
        setChartStateError(String(error));
      })
      .finally(() => {
        if (!cancelled) setChartStateLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [active, storyId, chartStateChapterId, visibleChartCharacterIds, milestones, skillEvents]);

  const toggleChartCharacter = (characterId: string) => {
    setHiddenChartCharacterIds(previous =>
      previous.includes(characterId)
        ? previous.filter(id => id !== characterId)
        : [...previous, characterId]
    );
  };

  return {
    // What the lines are read in, and the stat a "stat" line follows.
    chartMetric,
    setChartMetric,
    chartStatName,
    setChartStatName,
    statNameOptions,

    // The lines, and the ones the current metric and the hidden set leave.
    chartSeries,
    chartMilestoneSeries,
    chartMetricSeries,
    visibleChartSeries,
    visibleComparisonSeries,
    hiddenChartCharacterIds,
    toggleChartCharacter,

    // The chapter readout.
    chartStateChapters,
    chartStateChapter,
    chartStateChapterId,
    setChartStateChapterId,
    chartStateById,
    chartStateLoading,
    chartStateError,
  };
}
