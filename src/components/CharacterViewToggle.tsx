// The two views of the Characters tab, in one place so the sheet and the map
// describe the switch the same way.
export function CharacterViewToggle({
  view,
  onChange,
}: {
  view: 'sheet' | 'relations' | 'skills';
  onChange: (view: 'sheet' | 'relations' | 'skills') => void;
}) {
  return (
    <div className="character-view-toggle" role="group" aria-label="Characters view">
      <button
        type="button"
        className={view === 'sheet' ? 'active' : ''}
        aria-pressed={view === 'sheet'}
        title="Edit the selected character's sheet"
        onClick={() => onChange('sheet')}
      >
        Sheets
      </button>
      <button
        type="button"
        className={view === 'relations' ? 'active' : ''}
        aria-pressed={view === 'relations'}
        title="Map the cast's relations and faction standings"
        onClick={() => onChange('relations')}
      >
        Relations
      </button>
      <button
        type="button"
        className={view === 'skills' ? 'active' : ''}
        aria-pressed={view === 'skills'}
        title="See how the cast's skills evolved and fused, tier by tier"
        onClick={() => onChange('skills')}
      >
        Skill trees
      </button>
    </div>
  );
}
