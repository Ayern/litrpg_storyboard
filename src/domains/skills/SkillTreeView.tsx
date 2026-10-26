import { useMemo, useState } from 'react';
import ReactFlow, { Background, Controls, Handle, Panel, Position } from 'reactflow';
import type { Edge, Node, NodeProps } from 'reactflow';
import { HelpTip } from '../../components/HelpTip';
import { nodeTypes } from '../canvas/types';
import type { Character, CharacterSkill, EvolutionType, SkillEvolution } from '../shared/types';
import { EVOLUTION_STYLES, evolutionPath, evolutionStyle } from './evolution';
import type { SkillEvolutionInput, SkillTreeNodeData } from './types';

// Defined once: React Flow re-creates every node when this object changes.
const skillTreeNodeTypes = { default: SkillTreeNode };

// One skill in the tree. The tier badge says how far it sits from a root, and
// the counts say how many links arrive and leave without opening the panel.
export function SkillTreeNode({ data }: NodeProps<SkillTreeNodeData>) {
  return (
    <div
      className={`skill-tree-node tier-${Math.min(data.tier + 1, 5)}${
        data.inDraftLoop ? ' loop-warning' : ''
      }`}
      data-loop={data.inDraftLoop ? 'true' : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <button
        type="button"
        className="skill-tree-node-body"
        title={`${data.label}${
          data.rank ? ` (${data.rank})` : ''
        } — ${data.characterName}.${
          data.inDraftLoop
            ? ' Part of the chain the chosen link would close into a loop.'
            : ''
        } Click for its evolution links.`}
        onClick={() => data.onSelect?.(data.skillId)}
      >
        <span className="skill-tree-node-topline">
          <span className="skill-tree-node-tier">Tier {data.tier + 1}</span>
          {data.rank && <span className="skill-tree-node-rank">{data.rank}</span>}
        </span>
        <span className="skill-tree-node-name">{data.label}</span>
        <span className="skill-tree-node-owner">{data.characterName}</span>
        <span className="skill-tree-node-counts">
          {data.prerequisites} in · {data.outcomes} out
        </span>
      </button>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// The Characters tab's third view: the cast's skills laid out in tiers, with one
// edge per recorded evolution. A skill can have several parents (a fusion), and
// the closure means a character's tree can reach a skill on somebody else's
// sheet when the two were fused. Everything is advisory bookkeeping: the tree
// never rewrites a skill.
export function SkillTreeView({
  skills,
  characters,
  evolutions,
  chapters,
  error,
  onCreate,
  onDelete,
  onOpenSkill,
}: {
  skills: CharacterSkill[];
  characters: Character[];
  evolutions: SkillEvolution[];
  chapters: { id: string; label: string }[];
  error: string | null;
  onCreate: (input: SkillEvolutionInput) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  onOpenSkill: (skill: CharacterSkill) => void;
}) {
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedEvolutionId, setSelectedEvolutionId] = useState<string | null>(null);
  const [characterFilter, setCharacterFilter] = useState('all');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    mode: 'prerequisite' as 'prerequisite' | 'outcome',
    otherId: '',
    type: 'upgrade' as EvolutionType,
    chapterId: '',
    requiredRank: '',
    notes: '',
  });

  const skillById = useMemo(
    () => new Map(skills.map(skill => [skill.id, skill])),
    [skills]
  );
  const characterNameById = useMemo(
    () => new Map(characters.map(character => [character.id, character.name])),
    [characters]
  );
  const chapterLabel = (id: string | null) =>
    id ? chapters.find(chapter => chapter.id === id)?.label ?? 'a chapter in the trash' : null;

  // A character's tree is the closure around their own skills: fusions can pull
  // in a skill from another sheet, and its outcomes stay visible too.
  const visibleSkillIds = useMemo(() => {
    if (characterFilter === 'all') return new Set(skills.map(skill => skill.id));

    const ids = new Set(
      skills.filter(skill => skill.character_id === characterFilter).map(skill => skill.id)
    );
    let grew = true;

    while (grew) {
      grew = false;

      for (const evolution of evolutions) {
        if (ids.has(evolution.parent_skill_id) && !ids.has(evolution.child_skill_id)) {
          ids.add(evolution.child_skill_id);
          grew = true;
        } else if (
          ids.has(evolution.child_skill_id) &&
          !ids.has(evolution.parent_skill_id)
        ) {
          ids.add(evolution.parent_skill_id);
          grew = true;
        }
      }
    }

    return ids;
  }, [characterFilter, evolutions, skills]);

  const visibleSkills = useMemo(
    () => skills.filter(skill => visibleSkillIds.has(skill.id)),
    [skills, visibleSkillIds]
  );
  const visibleEvolutions = useMemo(
    () =>
      evolutions.filter(
        evolution =>
          visibleSkillIds.has(evolution.parent_skill_id) &&
          visibleSkillIds.has(evolution.child_skill_id)
      ),
    [evolutions, visibleSkillIds]
  );

  const incoming = useMemo(() => {
    const map = new Map<string, SkillEvolution[]>();
    for (const evolution of visibleEvolutions) {
      map.set(evolution.child_skill_id, [
        ...(map.get(evolution.child_skill_id) ?? []),
        evolution,
      ]);
    }
    return map;
  }, [visibleEvolutions]);

  const outgoing = useMemo(() => {
    const map = new Map<string, SkillEvolution[]>();
    for (const evolution of visibleEvolutions) {
      map.set(evolution.parent_skill_id, [
        ...(map.get(evolution.parent_skill_id) ?? []),
        evolution,
      ]);
    }
    return map;
  }, [visibleEvolutions]);

  // A tier is one step beyond the deepest parent. A loop cannot be saved, but a
  // file written by something else could carry one; the visiting set stops the
  // walk rather than hanging the view.
  const tiers = useMemo(() => {
    const depth = new Map<string, number>();
    const visiting = new Set<string>();

    const visit = (id: string): number => {
      if (depth.has(id)) return depth.get(id) as number;
      if (visiting.has(id)) return 0;

      visiting.add(id);
      const parents = incoming.get(id) ?? [];
      const value =
        parents.length === 0
          ? 0
          : Math.max(...parents.map(parent => visit(parent.parent_skill_id) + 1));
      visiting.delete(id);
      depth.set(id, value);

      return value;
    };

    visibleSkills.forEach(skill => visit(skill.id));
    return depth;
  }, [incoming, visibleSkills]);

  const positions = useMemo(() => {
    const byTier = new Map<number, CharacterSkill[]>();

    for (const skill of visibleSkills) {
      const tier = tiers.get(skill.id) ?? 0;
      byTier.set(tier, [...(byTier.get(tier) ?? []), skill]);
    }

    const map = new Map<string, { x: number; y: number }>();

    for (const [tier, members] of byTier) {
      const ordered = [...members].sort(
        (a, b) =>
          (characterNameById.get(a.character_id) ?? '').localeCompare(
            characterNameById.get(b.character_id) ?? ''
          ) || a.name.localeCompare(b.name)
      );
      ordered.forEach((skill, index) => {
        map.set(skill.id, { x: 40 + tier * 260, y: 30 + index * 118 });
      });
    }

    return map;
  }, [characterNameById, tiers, visibleSkills]);

  const selectedSkill = selectedSkillId ? skillById.get(selectedSkillId) ?? null : null;
  const selectedEvolution = selectedEvolutionId
    ? evolutions.find(evolution => evolution.id === selectedEvolutionId) ?? null
    : null;

  // The loop the open form would close, as the chain of names it would join: a
  // new parent → child link closes a circle exactly when the child already
  // reaches the parent. Walking the links here means the author sees what is in
  // the way while choosing, not after a refusal.
  const draftLoop = useMemo(() => {
    if (!selectedSkill || !draft.otherId) return null;

    const parentSkillId =
      draft.mode === 'prerequisite' ? draft.otherId : selectedSkill.id;
    const childSkillId =
      draft.mode === 'prerequisite' ? selectedSkill.id : draft.otherId;
    const chain = evolutionPath(evolutions, childSkillId, parentSkillId);

    if (!chain) return null;

    const ids = [...chain, childSkillId];

    return { ids, names: ids.map(id => skillById.get(id)?.name ?? 'a skill in the trash') };
  }, [draft.mode, draft.otherId, evolutions, selectedSkill, skillById]);

  // The same chain as a lookup for the drawing: the skills it runs through and
  // the links it follows, so the tree can mark them instead of leaving the
  // warning in the panel alone.
  const draftLoopIds = useMemo(() => new Set(draftLoop?.ids ?? []), [draftLoop]);
  const draftLoopLinks = useMemo(() => {
    const links = new Set<string>();
    const ids = draftLoop?.ids ?? [];

    for (let index = 0; index < ids.length - 1; index += 1) {
      links.add(`${ids[index]}→${ids[index + 1]}`);
    }

    return links;
  }, [draftLoop]);

  const flowNodes: Node<SkillTreeNodeData>[] = useMemo(
    () =>
      visibleSkills.map(skill => ({
        id: skill.id,
        type: 'default',
        position: positions.get(skill.id) ?? { x: 40, y: 30 },
        data: {
          skillId: skill.id,
          label: skill.name,
          rank: skill.rank,
          characterName:
            characterNameById.get(skill.character_id) ?? 'a cast member in the trash',
          tier: tiers.get(skill.id) ?? 0,
          prerequisites: (incoming.get(skill.id) ?? []).length,
          outcomes: (outgoing.get(skill.id) ?? []).length,
          inDraftLoop: draftLoopIds.has(skill.id),
          onSelect: id => {
            setSelectedEvolutionId(null);
            setSelectedSkillId(id);
          },
        },
        className: draftLoopIds.has(skill.id) ? 'loop-warning' : undefined,
      })),
    [characterNameById, draftLoopIds, incoming, outgoing, positions, tiers, visibleSkills]
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      visibleEvolutions.map(evolution => {
        const style = evolutionStyle(evolution.evolution_type);
        const inLoop = draftLoopLinks.has(
          `${evolution.parent_skill_id}→${evolution.child_skill_id}`
        );

        return {
          id: evolution.id,
          source: evolution.parent_skill_id,
          target: evolution.child_skill_id,
          type: 'smoothstep',
          label: style.label,
          labelStyle: { fill: inLoop ? '#e06c75' : style.color, fontSize: 10 },
          labelBgStyle: { fill: '#14161a', fillOpacity: 0.85 },
          ...(inLoop ? { className: 'loop-warning', animated: true } : {}),
          style: inLoop
            ? { stroke: '#e06c75', strokeWidth: 3, strokeDasharray: '4 3' }
            : {
                stroke: style.color,
                strokeWidth: style.width,
                strokeDasharray: style.dash,
              },
          markerEnd: `url(#skill-tree-arrow-${evolution.evolution_type})`,
        };
      }),
    [draftLoopLinks, visibleEvolutions]
  );

  const selectSkill = (skillId: string) => {
    setSelectedEvolutionId(null);
    setSelectedSkillId(skillId);
    setDraft(current => ({ ...current, otherId: '' }));
  };

  const addLink = async () => {
    if (!selectedSkill || !draft.otherId || draftLoop) return;

    const parentSkillId =
      draft.mode === 'prerequisite' ? draft.otherId : selectedSkill.id;
    const childSkillId =
      draft.mode === 'prerequisite' ? selectedSkill.id : draft.otherId;

    setSaving(true);
    const saved = await onCreate({
      parentSkillId,
      childSkillId,
      evolutionType: draft.type,
      chapterId: draft.chapterId || null,
      requiredRank: draft.requiredRank.trim() || null,
      notes: draft.notes.trim() || null,
    });
    setSaving(false);

    if (saved) {
      setDraft(current => ({
        ...current,
        otherId: '',
        requiredRank: '',
        notes: '',
      }));
    }
  };

  const otherChoices = skills.filter(skill => skill.id !== selectedSkill?.id);

  return (
    <div className="skill-tree-panel">
      <div className="skill-tree-toolbar">
        <div>
          <h3 className="skill-tree-title">Skill trees</h3>
          <p className="skill-tree-caption">
            {visibleSkills.length} skill{visibleSkills.length === 1 ? '' : 's'} ·{' '}
            {visibleEvolutions.length} link{visibleEvolutions.length === 1 ? '' : 's'}.
            Click a skill or a line to open it.
          </p>
        </div>
        <label className="skill-tree-filter">
          Character
          <select
            aria-label="Skill tree character"
            value={characterFilter}
            onChange={event => {
              setCharacterFilter(event.target.value);
              setSelectedSkillId(null);
              setSelectedEvolutionId(null);
            }}
          >
            <option value="all">All cast</option>
            {characters.map(character => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="skill-tree-error" role="alert">
          {error}
          <HelpTip label="links that would close a loop">
            Links point one way, from a skill to what it becomes. A link that would
            lead back to where it started is refused, because a loop would make the
            tiers and the chapter order meaningless. Point the link at a later skill
            instead.
          </HelpTip>
        </div>
      )}

      <div className="skill-tree-body">
        <div className="skill-tree-canvas">
          <svg className="skill-tree-markers" aria-hidden="true">
            <defs>
              {Object.entries(EVOLUTION_STYLES).map(([type, style]) => (
                <marker
                  key={type}
                  id={`skill-tree-arrow-${type}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={style.color} />
                </marker>
              ))}
            </defs>
          </svg>
          {visibleSkills.length === 0 ? (
            <div className="skill-tree-empty">
              No skills yet — add one on a character's sheet and the tree has
              something to show.
            </div>
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={skillTreeNodeTypes}
              onNodeClick={(_, node) => selectSkill(node.id)}
              onEdgeClick={(_, edge) => {
                setSelectedSkillId(null);
                setSelectedEvolutionId(edge.id);
              }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              fitView
            >
              <Controls showInteractive={false} />
              <Background />
              <Panel position="top-right">
                <div className="skill-tree-legend" role="group" aria-label="Evolution styles">
                  {Object.entries(EVOLUTION_STYLES).map(([type, style]) => (
                    <span key={type} className="skill-tree-legend-item">
                      <svg width={26} height={8} aria-hidden="true">
                        <line
                          x1={1}
                          y1={4}
                          x2={25}
                          y2={4}
                          stroke={style.color}
                          strokeWidth={style.width}
                          strokeDasharray={style.dash}
                        />
                      </svg>
                      {style.label}
                    </span>
                  ))}
                </div>
              </Panel>
            </ReactFlow>
          )}
        </div>

        <aside className="skill-tree-details" aria-label="Skill tree details">
          {selectedEvolution ? (
            (() => {
              const style = evolutionStyle(selectedEvolution.evolution_type);
              const parent = skillById.get(selectedEvolution.parent_skill_id);
              const child = skillById.get(selectedEvolution.child_skill_id);
              const chapter = chapterLabel(selectedEvolution.chapter_id);

              return (
                <>
                  <div className="skill-tree-details-head">
                    <h4>Evolution link</h4>
                    <button
                      type="button"
                      className="skill-tree-details-close"
                      aria-label="Close evolution details"
                      onClick={() => setSelectedEvolutionId(null)}
                    >
                      ×
                    </button>
                  </div>
                  <p className="skill-tree-edge-title">
                    {parent?.name ?? 'a skill in the trash'} →{' '}
                    {child?.name ?? 'a skill in the trash'}
                  </p>
                  <dl className="skill-tree-facts">
                    <div>
                      <dt>Kind</dt>
                      <dd style={{ color: style.color }}>{style.label}</dd>
                    </div>
                    {selectedEvolution.required_rank && (
                      <div>
                        <dt>Parent rank</dt>
                        <dd>{selectedEvolution.required_rank}</dd>
                      </div>
                    )}
                    {chapter && (
                      <div>
                        <dt>Chapter</dt>
                        <dd>{chapter}</dd>
                      </div>
                    )}
                    {selectedEvolution.notes && (
                      <div>
                        <dt>Notes</dt>
                        <dd>{selectedEvolution.notes}</dd>
                      </div>
                    )}
                  </dl>
                  <button
                    type="button"
                    className="skill-tree-open-sheet"
                    title={`Open ${child?.name ?? 'the child skill'} to add another link`}
                    onClick={() => {
                      if (child) selectSkill(child.id);
                    }}
                  >
                    Add another link for {child?.name ?? 'this skill'}
                  </button>
                  <button
                    type="button"
                    className="skill-tree-delete"
                    title="Remove this evolution link; both skills stay"
                    onClick={() => {
                      void onDelete(selectedEvolution.id).then(() =>
                        setSelectedEvolutionId(null)
                      );
                    }}
                  >
                    Delete link
                  </button>
                </>
              );
            })()
          ) : selectedSkill ? (
            <>
              <div className="skill-tree-details-head">
                <h4>{selectedSkill.name}</h4>
                <button
                  type="button"
                  className="skill-tree-details-close"
                  aria-label="Close skill details"
                  onClick={() => setSelectedSkillId(null)}
                >
                  ×
                </button>
              </div>
              <p className="skill-tree-skill-owner">
                {characterNameById.get(selectedSkill.character_id) ??
                  'A cast member in the trash'}
                {selectedSkill.rank ? ` · ${selectedSkill.rank}` : ''}
              </p>
              <button
                type="button"
                className="skill-tree-open-sheet"
                title="Open this skill on its character's sheet"
                onClick={() => onOpenSkill(selectedSkill)}
              >
                Open on sheet
              </button>

              <div className="skill-tree-links-block">
                <h5>Prerequisites</h5>
                {(incoming.get(selectedSkill.id) ?? []).length === 0 ? (
                  <p className="skill-tree-none">No parent skill recorded.</p>
                ) : (
                  <ul>
                    {(incoming.get(selectedSkill.id) ?? []).map(evolution => {
                      const parent = skillById.get(evolution.parent_skill_id);
                      const style = evolutionStyle(evolution.evolution_type);

                      return (
                        <li key={evolution.id}>
                          <button
                            type="button"
                            className="skill-tree-link"
                            onClick={() => {
                              setSelectedEvolutionId(evolution.id);
                              setSelectedSkillId(null);
                            }}
                          >
                            <span style={{ color: style.color }}>{style.label}</span>{' '}
                            {parent?.name ?? 'a skill in the trash'}
                            {evolution.required_rank
                              ? ` at ${evolution.required_rank}`
                              : ''}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="skill-tree-links-block">
                <h5>Evolves into</h5>
                {(outgoing.get(selectedSkill.id) ?? []).length === 0 ? (
                  <p className="skill-tree-none">No outcome recorded yet.</p>
                ) : (
                  <ul>
                    {(outgoing.get(selectedSkill.id) ?? []).map(evolution => {
                      const child = skillById.get(evolution.child_skill_id);
                      const style = evolutionStyle(evolution.evolution_type);

                      return (
                        <li key={evolution.id}>
                          <button
                            type="button"
                            className="skill-tree-link"
                            onClick={() => {
                              setSelectedEvolutionId(evolution.id);
                              setSelectedSkillId(null);
                            }}
                          >
                            <span style={{ color: style.color }}>{style.label}</span>{' '}
                            {child?.name ?? 'a skill in the trash'}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="skill-tree-link-form">
                <h5 id="skill-link-form-title">Add a link</h5>
                <div className="skill-tree-link-mode" role="group" aria-label="Link direction">
                  <button
                    type="button"
                    className={draft.mode === 'prerequisite' ? 'active' : ''}
                    aria-pressed={draft.mode === 'prerequisite'}
                    onClick={() => setDraft(current => ({ ...current, mode: 'prerequisite' }))}
                  >
                    Add prerequisite
                  </button>
                  <button
                    type="button"
                    className={draft.mode === 'outcome' ? 'active' : ''}
                    aria-pressed={draft.mode === 'outcome'}
                    onClick={() => setDraft(current => ({ ...current, mode: 'outcome' }))}
                  >
                    Add outcome
                  </button>
                </div>
                <select
                  aria-label="Linked skill"
                  title={
                    draft.mode === 'prerequisite'
                      ? `The earlier skill ${selectedSkill.name} grew out of`
                      : `The later skill ${selectedSkill.name} becomes`
                  }
                  value={draft.otherId}
                  onChange={event =>
                    setDraft(current => ({ ...current, otherId: event.target.value }))
                  }
                >
                  <option value="">
                    {draft.mode === 'prerequisite' ? 'Choose a parent' : 'Choose an outcome'}
                  </option>
                  {otherChoices.map(skill => (
                    <option key={skill.id} value={skill.id}>
                      {skill.name} —{' '}
                      {characterNameById.get(skill.character_id) ?? 'cast in the trash'}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Evolution kind"
                  title="How the later skill came to be"
                  value={draft.type}
                  onChange={event =>
                    setDraft(current => ({
                      ...current,
                      type: event.target.value as EvolutionType,
                    }))
                  }
                >
                  {Object.entries(EVOLUTION_STYLES).map(([type, style]) => (
                    <option key={type} value={type}>
                      {style.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Evolution chapter"
                  title="Where in the reading order the change happens"
                  value={draft.chapterId}
                  onChange={event =>
                    setDraft(current => ({ ...current, chapterId: event.target.value }))
                  }
                >
                  <option value="">No chapter</option>
                  {chapters.map(chapter => (
                    <option key={chapter.id} value={chapter.id}>
                      {chapter.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Required parent rank"
                  title="Optional: the parent rank this step needed"
                  placeholder="Parent rank (optional)"
                  value={draft.requiredRank}
                  onChange={event =>
                    setDraft(current => ({ ...current, requiredRank: event.target.value }))
                  }
                  onKeyDown={event => {
                    if (event.key === 'Enter') void addLink();
                  }}
                />
                <input
                  aria-label="Evolution notes"
                  title="Optional bookkeeping notes"
                  placeholder="Notes (optional)"
                  value={draft.notes}
                  onChange={event =>
                    setDraft(current => ({ ...current, notes: event.target.value }))
                  }
                  onKeyDown={event => {
                    if (event.key === 'Enter') void addLink();
                  }}
                />
                {draftLoop && (
                  <p className="skill-tree-cycle" role="status">
                    <strong>This link would close a loop:</strong>{' '}
                    {draftLoop.names.join(' → ')}. The chain is marked on the tree.
                    Point the link at a later skill instead, or delete one of the
                    links above.
                  </p>
                )}
                <button
                  type="button"
                  className="skill-tree-add"
                  disabled={saving || !draft.otherId || Boolean(draftLoop)}
                  title={
                    draftLoop
                      ? 'Links point one way only; this one would lead back to where it started'
                      : 'Record this link on both skills'
                  }
                  onClick={() => void addLink()}
                >
                  {saving ? 'Adding…' : 'Add link'}
                </button>
              </div>
            </>
          ) : (
            <div className="skill-tree-details-empty">
              <h4>Skill tree</h4>
              <p>
                Click a skill to see what it grew out of and what it becomes, or
                click a line for the link's chapter and requirements.
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
