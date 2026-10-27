import type { Node } from 'reactflow';
import { CharacterViewToggle } from '../../components/CharacterViewToggle';
import type { NodeData } from '../canvas/types';
import { RelationsMap } from '../relations/RelationsMap';
import { SkillTreeView } from '../skills/SkillTreeView';
import type { SkillEvolutionInput } from '../skills/types';
import type {
  Character,
  CharacterRelation,
  CharacterSkill,
  FactionStanding,
  SkillEvolution,
} from '../shared/types';
import type { Story } from '../stories/types';

// The Characters tab's other two views. Each is the same shape: the switch that
// says which view is open, a sentence instead of an empty diagram when no story
// is loaded, and the diagram itself. The app still owns the rows and the way an
// entry opens its sheet, so both arrive as props; only the chapter and faction
// cards are narrowed to the labels the diagrams draw.

type CharacterView = 'sheet' | 'relations' | 'skills';

export interface CharacterRelationsViewProps {
  story: Story | null;
  onViewChange: (view: CharacterView) => void;
  characters: Character[];
  relations: CharacterRelation[];
  standings: FactionStanding[];
  factionCards: Node<NodeData>[];
  onOpenRelation: (relation: CharacterRelation) => void;
  onOpenStanding: (standing: FactionStanding) => void;
}

export function CharacterRelationsView({
  story,
  onViewChange,
  characters,
  relations,
  standings,
  factionCards,
  onOpenRelation,
  onOpenStanding,
}: CharacterRelationsViewProps) {
  return (
    <div className="tab-content">
      <CharacterViewToggle view="relations" onChange={onViewChange} />
      {!story ? (
        <div className="empty-state">Load a story to map its cast</div>
      ) : (
        <RelationsMap
          characters={characters}
          relations={relations}
          standings={standings}
          factions={factionCards.map(node => ({
            id: node.id,
            label: node.data.label,
          }))}
          onOpenRelation={onOpenRelation}
          onOpenStanding={onOpenStanding}
        />
      )}
    </div>
  );
}

export interface CharacterSkillsViewProps {
  story: Story | null;
  onViewChange: (view: CharacterView) => void;
  skills: CharacterSkill[];
  characters: Character[];
  evolutions: SkillEvolution[];
  chapterNodes: Node<NodeData>[];
  error: string | null;
  onCreate: (input: SkillEvolutionInput) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  onOpenSkill: (skill: CharacterSkill) => void;
}

export function CharacterSkillsView({
  story,
  onViewChange,
  skills,
  characters,
  evolutions,
  chapterNodes,
  error,
  onCreate,
  onDelete,
  onOpenSkill,
}: CharacterSkillsViewProps) {
  return (
    <div className="tab-content">
      <CharacterViewToggle view="skills" onChange={onViewChange} />
      {!story ? (
        <div className="empty-state">Load a story to see how its skills evolved</div>
      ) : (
        <SkillTreeView
          skills={skills}
          characters={characters}
          evolutions={evolutions}
          chapters={chapterNodes.map(node => ({
            id: node.id,
            label: node.data.label,
          }))}
          error={error}
          onCreate={onCreate}
          onDelete={onDelete}
          onOpenSkill={onOpenSkill}
        />
      )}
    </div>
  );
}
