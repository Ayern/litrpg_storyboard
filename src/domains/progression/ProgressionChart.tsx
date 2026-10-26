import type { Node } from 'reactflow';
import type { NodeData } from '../canvas/types';
import type { Character, CharacterLevelMilestone, CharacterProgress } from '../shared/types';
import type { ProgressionChartSeries, ProgressionMetric } from './types';
import { milestoneStatChanges } from './helpers';

// A small hand-drawn SVG chart, so the comparison needs no charting dependency.
// The x-axis is the chapter list in reading order; each line steps at the chapter
// where a milestone lands, which is how the ledger actually reads.
export function ProgressionChart({
  chapters,
  series,
  metric,
  statName,
}: {
  chapters: Node<NodeData>[];
  series: ProgressionChartSeries[];
  metric: ProgressionMetric;
  statName: string;
}) {
  const width = 760;
  const height = 260;
  const margin = { top: 18, right: 18, bottom: 38, left: 46 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const chapterIndex = new Map(chapters.map((chapter, index) => [chapter.id, index]));
  const metricValue = (milestone: CharacterLevelMilestone): number | null => {
    if (metric === 'level') return milestone.level;
    if (metric === 'xp') return milestone.xp ?? null;
    if (metric === 'earned') return null;

    return (
      milestoneStatChanges(milestone).find(
        change => change.stat_name === statName && change.value_after != null
      )?.value_after ?? null
    );
  };
  const metricTitle =
    metric === 'level'
      ? 'Character levels'
      : metric === 'xp'
        ? 'Character XP'
        : metric === 'earned'
          ? 'XP earned'
          : statName || 'Stats';

  const built = series.map(entry => {
    const ordered = entry.milestones
      .filter(
        milestone =>
          milestone.chapter_id !== null && chapterIndex.has(milestone.chapter_id)
      )
      .sort(
        (a, b) =>
          (chapterIndex.get(a.chapter_id as string) as number) -
            (chapterIndex.get(b.chapter_id as string) as number) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id)
      );

    // One point per chapter per metric, as in the continuity checks: the last
    // milestone that recorded this metric in the chapter is the one that counts.
    // A later milestone without XP or a stat snapshot does not erase it.
    const byChapter = new Map<
      number,
      { milestone: CharacterLevelMilestone; value: number }
    >();

    for (const milestone of ordered) {
      const value = metricValue(milestone);
      if (value === null) continue;

      byChapter.set(
        chapterIndex.get(milestone.chapter_id as string) as number,
        { milestone, value }
      );
    }

    const markers = [...byChapter.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, point]) => ({ index, ...point }));
    const steps: { index: number; value: number }[] = [];
    let active: number | null = null;

    for (let index = 0; index < chapters.length; index += 1) {
      const point = byChapter.get(index);
      if (point) active = point.value;
      if (active !== null) steps.push({ index, value: active });
    }

    // Income is what happened in one chapter, so it is a bar rather than a step
    // that carries forward. One chapter has at most one row per character.
    const progressByChapter = new Map<number, CharacterProgress>();

    for (const progressEntry of entry.progress) {
      const index = chapterIndex.get(progressEntry.chapter_id);
      if (index !== undefined) progressByChapter.set(index, progressEntry);
    }

    const bars = [...progressByChapter.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, progressEntry]) => ({
        index,
        progressEntry,
        value: progressEntry.xp_earned,
      }));

    return { ...entry, markers, steps, bars };
  });

  const values =
    metric === 'earned'
      ? built.flatMap(entry => entry.bars.map(bar => bar.value))
      : built.flatMap(entry => entry.markers.map(marker => marker.value));
  const lowest = values.length > 0 ? Math.min(...values) : 0;
  const highest = values.length > 0 ? Math.max(...values) : 1;
  const pad = highest === lowest ? 1 : Math.max(1, Math.ceil((highest - lowest) * 0.15));
  const yMin =
    metric === 'xp' || metric === 'earned'
      ? 0
      : lowest >= 0
        ? Math.max(0, lowest - pad)
        : lowest - pad;
  const yMax = Math.max(highest + pad, yMin + 1);
  const chapterSlot = plotWidth / Math.max(1, chapters.length);
  const chapterCenter = (index: number) =>
    chapters.length <= 1
      ? margin.left + plotWidth / 2
      : margin.left + (index + 0.5) * chapterSlot;
  const x = (index: number) =>
    chapters.length <= 1
      ? margin.left + plotWidth / 2
      : margin.left + (index / (chapters.length - 1)) * plotWidth;
  const y = (value: number) =>
    margin.top + ((yMax - value) / Math.max(1, yMax - yMin)) * plotHeight;
  const barGroupWidth = chapterSlot * 0.68;
  const barWidth = barGroupWidth / Math.max(1, built.length);
  const barX = (index: number, seriesIndex: number) =>
    margin.left +
    index * chapterSlot +
    (chapterSlot - barGroupWidth) / 2 +
    seriesIndex * barWidth;
  const ticks = [0, 1, 2, 3, 4].map(
    step => yMin + ((yMax - yMin) * step) / 4
  );
  const labelEvery = Math.max(1, Math.ceil(chapters.length / 8));
  const names = series.map(entry => entry.name).join(', ');
  const pointText = (marker: { milestone: CharacterLevelMilestone; value: number }) => {
    if (metric === 'level') {
      return `level ${marker.value}${marker.milestone.is_debuff ? ' (penalty)' : ''}`;
    }
    if (metric === 'xp') return `total XP ${marker.value}`;

    return `${statName || 'primary stat'} ${marker.value}`;
  };

  return (
    <svg
      className="progression-chart-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      data-metric={metric}
      aria-label={`${metricTitle} for ${names} across ${chapters.length} chapters in reading order`}
    >
      <title>
        {`${metricTitle} for ${names} across ${chapters.length} chapters in reading order`}
      </title>

      {ticks.map(tick => {
        const label = Number.isInteger(tick) ? String(tick) : tick.toFixed(1);

        return (
          <g key={`${metric}-${label}`}>
            <line
              className="progression-chart-grid-line"
              x1={margin.left}
              x2={width - margin.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text
              className="progression-chart-axis-label"
              x={margin.left - 8}
              y={y(tick) + 4}
              textAnchor="end"
            >
              {label}
            </text>
          </g>
        );
      })}

      <line
        className="progression-chart-axis"
        x1={margin.left}
        x2={margin.left}
        y1={margin.top}
        y2={height - margin.bottom}
      />
      <line
        className="progression-chart-axis"
        x1={margin.left}
        x2={width - margin.right}
        y1={height - margin.bottom}
        y2={height - margin.bottom}
      />

      {chapters.map((chapter, index) => {
        if (
          index !== 0 &&
          index !== chapters.length - 1 &&
          index % labelEvery !== 0
        ) {
          return null;
        }

        return (
          <text
            key={chapter.id}
            className="progression-chart-axis-label"
            x={metric === 'earned' ? chapterCenter(index) : x(index)}
            y={height - margin.bottom + 16}
            textAnchor="middle"
          >
            {chapter.data.chapterSeq != null ? `Ch. ${chapter.data.chapterSeq}` : 'Unplaced'}
          </text>
        );
      })}

      <text
        className="progression-chart-axis-title"
        x={margin.left + plotWidth / 2}
        y={height - 4}
        textAnchor="middle"
      >
        Chapter in reading order
      </text>

      {built.map((entry, seriesIndex) => {
        const d = entry.steps
          .map(
            (step, index) =>
              `${index === 0 ? 'M' : 'H'} ${x(step.index)} ${
                index === 0 ? y(step.value) : ''
              }${index === 0 ? '' : ` V ${y(step.value)}`}`
          )
          .join(' ');

        return (
          <g key={entry.characterId} data-series={entry.characterId}>
            <title>
              {metric === 'earned'
                ? entry.bars
                    .map(
                      bar =>
                        `${chapters[bar.index].data.label}: ${bar.value} XP earned`
                    )
                    .join(', ')
                : entry.markers
                    .map(
                      marker =>
                        `${chapters[marker.index].data.label}: ${pointText(marker)}`
                    )
                    .join(', ')}
            </title>

            {metric === 'earned'
              ? entry.bars.map(bar => {
                  const chapter = chapters[bar.index];
                  const barHeight = Math.max(1, y(0) - y(bar.value));

                  return (
                    <rect
                      key={bar.progressEntry.id}
                      className="progression-chart-bar"
                      data-chapter-id={chapter.id}
                      data-value={bar.value}
                      data-metric="earned"
                      x={barX(bar.index, seriesIndex) + 1}
                      y={y(bar.value)}
                      width={Math.max(1, barWidth - 2)}
                      height={barHeight}
                      rx={1}
                      fill={entry.color}
                    >
                      <title>
                        {`${entry.name} — ${chapter.data.label}: ${bar.value} XP earned`}
                      </title>
                    </rect>
                  );
                })
              : (
                  <>
                    <path
                      className="progression-chart-line"
                      d={d}
                      stroke={entry.color}
                      fill="none"
                    />
                    {entry.markers.map(marker => {
                      const chapter = chapters[marker.index];
                      const penaltyMarker =
                        metric === 'level' && marker.milestone.is_debuff;

                      return (
                        <circle
                          key={marker.milestone.id}
                          className="progression-chart-marker"
                          data-chapter-id={chapter.id}
                          data-level={marker.milestone.level}
                          data-value={marker.value}
                          data-metric={metric}
                          data-penalty={marker.milestone.is_debuff ? 'true' : 'false'}
                          cx={x(marker.index)}
                          cy={y(marker.value)}
                          r={penaltyMarker ? 5 : 3.8}
                          fill={entry.color}
                        >
                          <title>
                            {`${entry.name} — ${chapter.data.label}: ${pointText(marker)}`}
                          </title>
                        </circle>
                      );
                    })}
                  </>
                )}
          </g>
        );
      })}
    </svg>
  );
}
