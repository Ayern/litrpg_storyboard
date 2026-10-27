import { useState } from 'react';
import type { CharacterAttribute } from './types';

// The sheet's attribute rows: Class, Title, Aura, Affinity. An attribute is a
// named string rather than a number, one per name per character, and setting a
// name that already exists updates it - which is why the creator's hint says so
// rather than refusing the save.
//
// The form state lives here: the open row with the value being typed, and the
// two fields that add a row. Every write is handed back to the app, which owns
// the audit step, because a story's attributes are read by the level-up form and
// the canvas as well as by this sheet. A write answers whether it happened, so a
// refused save leaves the field open where the author left it.

export interface AttributeListProps {
  attributes: CharacterAttribute[];
  onError: (message: string | null) => void;
  onCreate: (name: string, value: string) => Promise<boolean>;
  onSave: (attribute: CharacterAttribute, value: string) => Promise<boolean>;
  onDelete: (attribute: CharacterAttribute) => Promise<boolean>;
}

export function AttributeList({
  attributes,
  onError,
  onCreate,
  onSave,
  onDelete,
}: AttributeListProps) {
  const [editingAttributeId, setEditingAttributeId] = useState<string | null>(null);
  const [attributeValueDraft, setAttributeValueDraft] = useState('');
  const [newAttributeName, setNewAttributeName] = useState('');
  const [newAttributeValue, setNewAttributeValue] = useState('');

  const startAttributeEdit = (attribute: CharacterAttribute) => {
    setEditingAttributeId(attribute.id);
    setAttributeValueDraft(attribute.value);
  };

  // The value is the one field this sheet will not save empty: an attribute with
  // no value is not an attribute, and deleting it is how it goes away.
  const saveAttribute = async (attribute: CharacterAttribute) => {
    const value = attributeValueDraft.trim();

    if (!value) {
      onError('An attribute needs a value — delete it to remove it.');
      return;
    }

    if (await onSave(attribute, value)) setEditingAttributeId(null);
  };

  const addAttribute = async () => {
    const name = newAttributeName.trim();
    const value = newAttributeValue.trim();

    if (!name) return;

    if (!value) {
      onError('An attribute needs a value.');
      return;
    }

    if (!(await onCreate(name, value))) return;

    setNewAttributeName('');
    setNewAttributeValue('');
  };

  const removeAttribute = async (attribute: CharacterAttribute) => {
    if (await onDelete(attribute)) setEditingAttributeId(null);
  };

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
