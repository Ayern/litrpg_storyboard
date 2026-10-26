import { useMemo, useState } from 'react';
import type {
  Character,
  CharacterRelation,
  FactionStanding,
  SkillEvolution,
} from '../shared/types';

// How each relation kind is drawn. The five suggested kinds have their own
// colour and line shape so the map reads without the legend; anything the author
// types gets a neutral grey line rather than being hidden.
export const RELATION_STYLES: Record<string, { color: string; dash?: string; arrow?: boolean }> = {
  ally: { color: '#6fbf8f' },
  rival: { color: '#d77a7a', dash: '6 4' },
  mentor: { color: '#d9b36c', arrow: true },
  family: { color: '#b18fd6', dash: '2 4' },
  owes: { color: '#9aa4b2', dash: '4 3', arrow: true },
};

export function relationStyle(kind: string) {
  return RELATION_STYLES[kind.trim().toLowerCase()] ?? { color: '#8a8a8a' };
}

// SVG text never wraps, so a long name is shortened in the box and kept whole in
// the hover title rather than spilling over its neighbours.
export function mapLabel(label: string, limit = 18) {
  return label.length > limit ? `${label.slice(0, limit - 1)}…` : label;
}

// The cast map in the Characters tab. It is a schematic rather than another
// canvas: people sit on a ring, factions in the middle, and a line joins every
// recorded bond. Clicking a name focuses that person and dims the rest; clicking
// a line opens the relation's own editor on the sheet, where it is changed.
export function RelationsMap({
  characters,
  relations,
  standings,
  factions,
  onOpenRelation,
  onOpenStanding,
}: {
  characters: Character[];
  relations: CharacterRelation[];
  standings: FactionStanding[];
  factions: { id: string; label: string }[];
  onOpenRelation: (relation: CharacterRelation) => void;
  onOpenStanding: (standing: FactionStanding) => void;
}) {
  const [focusedCharacterId, setFocusedCharacterId] = useState<string | null>(null);

  const width = 760;
  const height = 480;
  const center = { x: width / 2, y: height / 2 };

  const castPoints = useMemo(() => {
    const points = new Map<string, { x: number; y: number }>();
    const radius = Math.min(210, 80 + characters.length * 22);

    characters.forEach((character, index) => {
      const angle =
        (2 * Math.PI * index) / Math.max(characters.length, 1) - Math.PI / 2;
      points.set(character.id, {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius * 0.82,
      });
    });

    return points;
  }, [characters]);

  const factionPoints = useMemo(() => {
    const points = new Map<string, { x: number; y: number }>();
    const gap = 62;
    const startY = center.y - ((factions.length - 1) * gap) / 2;

    factions.forEach((faction, index) => {
      points.set(faction.id, { x: center.x, y: startY + index * gap });
    });

    return points;
  }, [factions]);

  const nameById = useMemo(
    () => new Map(characters.map(character => [character.id, character.name])),
    [characters]
  );

  const factionLabel = (id: string | null) =>
    factions.find(faction => faction.id === id)?.label ?? 'a faction no longer on the board';

  const focus = (characterId: string) =>
    setFocusedCharacterId(current => (current === characterId ? null : characterId));

  if (characters.length === 0) {
    return (
      <div className="relations-map-empty">
        No cast yet — add a character and the map has something to join.
      </div>
    );
  }

  return (
    <div className="relations-map-panel">
      <div className="relations-map-head">
        <p className="relations-map-caption">
          Rivalries, alliances and mentorships between the cast, with faction
          standings in the middle. Click a name to focus it; click a line to open
          its entry.
        </p>
        {focusedCharacterId && (
          <button
            type="button"
            className="relations-map-clear"
            title="Show every character again"
            onClick={() => setFocusedCharacterId(null)}
          >
            Clear focus
          </button>
        )}
      </div>

      <svg
        className="relations-map"
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label="Cast relations map"
      >
        <defs>
          <marker
            id="relations-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#d9b36c" />
          </marker>
        </defs>

        <rect
          className="relations-map-background"
          width={width}
          height={height}
          onClick={() => setFocusedCharacterId(null)}
        />

        {standings.map(standing => {
          const from = castPoints.get(standing.character_id);
          const to = standing.faction_node_id
            ? factionPoints.get(standing.faction_node_id)
            : null;

          if (!from || !to) return null;

          const dimmed =
            focusedCharacterId != null && focusedCharacterId !== standing.character_id;
          const person = nameById.get(standing.character_id) ?? 'A cast member';

          return (
            <g
              key={`standing-${standing.id}`}
              className={`relations-membership${dimmed ? ' dimmed' : ''}`}
            >
              <line
                className="relations-edge-hit"
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                role="button"
                tabIndex={0}
                aria-label={`Edit ${person}'s ${standing.standing} standing in ${factionLabel(
                  standing.faction_node_id
                )}`}
                onClick={() => onOpenStanding(standing)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpenStanding(standing);
                  }
                }}
              />
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="#7f8fa6"
                strokeWidth={1.5}
                strokeDasharray="3 4"
                pointerEvents="none"
              />
              <text
                className="relations-membership-label"
                x={(from.x + to.x) / 2}
                y={(from.y + to.y) / 2 + 12}
                textAnchor="middle"
              >
                {standing.standing}
              </text>
            </g>
          );
        })}

        {relations.map(relation => {
          const from = castPoints.get(relation.from_character_id);
          const to = castPoints.get(relation.to_character_id);

          if (!from || !to) return null;

          const style = relationStyle(relation.kind);
          const dimmed =
            focusedCharacterId != null &&
            relation.from_character_id !== focusedCharacterId &&
            relation.to_character_id !== focusedCharacterId;
          const fromName =
            nameById.get(relation.from_character_id) ?? 'a cast member in the trash';
          const toName =
            nameById.get(relation.to_character_id) ?? 'a cast member in the trash';

          return (
            <g
              key={`relation-${relation.id}`}
              className={`relations-edge${dimmed ? ' dimmed' : ''}`}
            >
              <line
                className="relations-edge-hit"
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                role="button"
                tabIndex={0}
                aria-label={`Edit the ${relation.kind} relation between ${fromName} and ${toName}`}
                onClick={() => onOpenRelation(relation)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpenRelation(relation);
                  }
                }}
              />
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={style.color}
                strokeWidth={2}
                strokeDasharray={style.dash}
                markerEnd={style.arrow ? 'url(#relations-arrow)' : undefined}
                pointerEvents="none"
              />
              <text
                className="relations-edge-label"
                x={(from.x + to.x) / 2}
                y={(from.y + to.y) / 2 - 6}
                textAnchor="middle"
              >
                {relation.kind}
              </text>
            </g>
          );
        })}

        {factions.map(faction => {
          const point = factionPoints.get(faction.id);

          if (!point) return null;

          const dimmed =
            focusedCharacterId != null &&
            !standings.some(
              standing =>
                standing.character_id === focusedCharacterId &&
                standing.faction_node_id === faction.id
            );

          return (
            <g
              key={`faction-${faction.id}`}
              className={`relations-faction${dimmed ? ' dimmed' : ''}`}
              transform={`translate(${point.x} ${point.y})`}
            >
              <rect x={-72} y={-16} width={144} height={32} rx={6} />
              <text textAnchor="middle" y={4}>
                {mapLabel(faction.label, 24)}
              </text>
            </g>
          );
        })}

        {characters.map(character => {
          const point = castPoints.get(character.id);

          if (!point) return null;

          const focused = focusedCharacterId === character.id;
          const dimmed = focusedCharacterId != null && !focused;

          return (
            <g
              key={`cast-${character.id}`}
              className={`relations-cast${focused ? ' focused' : ''}${
                dimmed ? ' dimmed' : ''
              }`}
              transform={`translate(${point.x} ${point.y})`}
              role="button"
              tabIndex={0}
              aria-pressed={focused}
              aria-label={
                focused ? `Stop focusing ${character.name}` : `Focus ${character.name}`
              }
              onClick={() => focus(character.id)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  focus(character.id);
                }
              }}
            >
              <rect x={-62} y={-18} width={124} height={36} rx={8} />
              <text textAnchor="middle" y={5}>
                {mapLabel(character.name)}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="relations-legend" role="group" aria-label="Relation styles">
        {['ally', 'rival', 'mentor', 'family', 'owes'].map(kind => {
          const style = relationStyle(kind);
          return (
            <span key={kind} className="relations-legend-item">
              <svg width={26} height={8} aria-hidden="true">
                <line
                  x1={1}
                  y1={4}
                  x2={25}
                  y2={4}
                  stroke={style.color}
                  strokeWidth={2}
                  strokeDasharray={style.dash}
                />
              </svg>
              {kind}
            </span>
          );
        })}
        <span className="relations-legend-item">
          <svg width={26} height={8} aria-hidden="true">
            <line
              x1={1}
              y1={4}
              x2={25}
              y2={4}
              stroke="#7f8fa6"
              strokeWidth={1.5}
              strokeDasharray="3 4"
            />
          </svg>
          faction
        </span>
      </div>
    </div>
  );
}
