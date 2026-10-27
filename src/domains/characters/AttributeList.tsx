import type { CharacterAttribute } from './types';

// The sheet's attribute rows: Class, Title, Aura, Affinity. An attribute is a
// named string rather than a number, one per name per character, and setting a
// name that already exists updates it - which is why the creator's hint says so
// rather than refusing the save.
//
// Rows are edited one at a time through a single draft: the open row's id and
// the value being typed. Both stay in the app beside the writes they feed, so an
// add, an update and a delete are each still one audited action.

export interface AttributeListProps {
  attributes: CharacterAttribute[];
  editingAttributeId: string | null;
  setEditingAttributeId: (attributeId: string | null) => void;
  attributeValueDraft: string;
  setAttributeValueDraft: (value: string) => void;
  startAttributeEdit: (attribute: CharacterAttribute) => void;
  saveAttribute: (attribute: CharacterAttribute) => Promise<void>;
  removeAttribute: (attribute: CharacterAttribute) => Promise<void>;
  newAttributeName: string;
  setNewAttributeName: (name: string) => void;
  newAttributeValue: string;
  setNewAttributeValue: (value: string) => void;
  addAttribute: () => Promise<void>;
}

export function AttributeList({
  attributes,
  editingAttributeId,
  setEditingAttributeId,
  attributeValueDraft,
  setAttributeValueDraft,
  startAttributeEdit,
  saveAttribute,
  removeAttribute,
  newAttributeName,
  setNewAttributeName,
  newAttributeValue,
  setNewAttributeValue,
  addAttribute,
}: AttributeListProps) {
  return (
    <div className="attribute-section">
      <h4 className="character-section-heading">Attributes</h4>

      <div className="attribute-list">
        {attributes.length === 0 && (
          <div className="empty">
            No attributes yet — Class, Title, Aura, Affinity.
          </div>
        )}

        {attributes.map(attribute => (
          <div key={attribute.id} className="attribute-row">
            <span className="attribute-name">{attribute.attr_name}</span>

            {editingAttributeId === attribute.id ? (
              <>
                <input
                  className="attribute-value-input"
                  autoFocus
                  value={attributeValueDraft}
                  onChange={(e) => setAttributeValueDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveAttribute(attribute);
                    if (e.key === 'Escape') setEditingAttributeId(null);
                  }}
                />
                <button
                  title={`Save this new ${attribute.attr_name} value`}
                  onClick={() => saveAttribute(attribute)}
                >
                  Save
                </button>
                <button
                  title="Leave the value as it was"
                  onClick={() => setEditingAttributeId(null)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="attribute-value">{attribute.value}</span>
                <button
                  title={`Change this ${attribute.attr_name} value`}
                  onClick={() => startAttributeEdit(attribute)}
                >
                  Edit
                </button>
                <button
                  title={`Delete ${attribute.attr_name}`}
                  onClick={() => removeAttribute(attribute)}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="attribute-creator">
        <input
          placeholder="Attribute (Class)"
          value={newAttributeName}
          onChange={(e) => setNewAttributeName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addAttribute()}
        />
        <input
          className="attribute-value-input"
          placeholder="Value (Rogue)"
          value={newAttributeValue}
          onChange={(e) => setNewAttributeValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addAttribute()}
        />
        <button
          title="Add this attribute, or update it if the name already exists"
          onClick={addAttribute}
          disabled={!newAttributeName.trim() || !newAttributeValue.trim()}
        >
          Add attribute
        </button>
      </div>
    </div>
  );
}
