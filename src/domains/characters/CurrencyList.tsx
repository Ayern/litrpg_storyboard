import { useState } from 'react';
import { formatCount } from '../../lib/format';
import type { CharacterCurrency } from '../inventory/types';

// The sheet's currency: a named amount per character. Nothing adds up across
// names, so gold and mana crystals stay separate rows rather than one balance,
// and each row is written on its own.
//
// The form state lives here: the open row, the two fields it holds, and the two
// fields that add a row. The amount is kept as typed rather than as a number, so
// what the author is typing is never reworded underneath them; the app parses it
// and is the one that answers whether the write happened, because the same
// parser guards the quantities on the inventory rows.

export interface CurrencyListProps {
  currencies: CharacterCurrency[];
  onCreate: (name: string, amount: string) => Promise<boolean>;
  onSave: (
    currency: CharacterCurrency,
    name: string,
    amount: string
  ) => Promise<boolean>;
  onDelete: (currency: CharacterCurrency) => Promise<boolean>;
}

export function CurrencyList({
  currencies,
  onCreate,
  onSave,
  onDelete,
}: CurrencyListProps) {
  const [editingCurrencyId, setEditingCurrencyId] = useState<string | null>(null);
  const [currencyNameDraft, setCurrencyNameDraft] = useState('');
  const [currencyAmountDraft, setCurrencyAmountDraft] = useState('0');
  const [newCurrencyName, setNewCurrencyName] = useState('');
  const [newCurrencyAmount, setNewCurrencyAmount] = useState('0');

  const startCurrencyEdit = (currency: CharacterCurrency) => {
    setEditingCurrencyId(currency.id);
    setCurrencyNameDraft(currency.name);
    setCurrencyAmountDraft(String(currency.amount));
  };

  // A row keeps its editor open until the app says the amount was written, so a
  // refused number stays in front of the author rather than being discarded.
  const saveCurrency = async (currency: CharacterCurrency) => {
    if (await onSave(currency, currencyNameDraft, currencyAmountDraft)) {
      setEditingCurrencyId(null);
    }
  };

  const addCurrency = async () => {
    if (!(await onCreate(newCurrencyName, newCurrencyAmount))) return;

    setNewCurrencyName('');
    setNewCurrencyAmount('0');
  };

  const removeCurrency = async (currency: CharacterCurrency) => {
    if (await onDelete(currency)) setEditingCurrencyId(null);
  };

  return (
    <div className="currency-section">
      <h4 className="character-section-heading">Currency</h4>

      <div className="currency-list">
        {currencies.length === 0 && (
          <div className="empty">No currency yet — add one below.</div>
        )}

        {currencies.map(currency => (
          <div key={currency.id} className="currency-row">
            {editingCurrencyId === currency.id ? (
              <div className="currency-editor">
                <input
                  aria-label="Currency name"
                  autoFocus
                  value={currencyNameDraft}
                  onChange={(e) => setCurrencyNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveCurrency(currency);
                    if (e.key === 'Escape') setEditingCurrencyId(null);
                  }}
                />
                <input
                  aria-label="Currency amount"
                  type="number"
                  min={0}
                  step={1}
                  value={currencyAmountDraft}
                  onChange={(e) => setCurrencyAmountDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveCurrency(currency);
                    if (e.key === 'Escape') setEditingCurrencyId(null);
                  }}
                />
                <div className="currency-actions">
                  <button
                    title={`Save this ${currency.name} amount`}
                    onClick={() => saveCurrency(currency)}
                  >
                    Save currency
                  </button>
                  <button
                    title="Leave the amount as it was"
                    onClick={() => setEditingCurrencyId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="currency-summary">
                  <span className="currency-amount">
                    {formatCount(currency.amount)}
                  </span>
                  <span className="currency-name">{currency.name}</span>
                </div>
                <button
                  title={`Change the amount of ${currency.name}`}
                  onClick={() => startCurrencyEdit(currency)}
                >
                  Edit
                </button>
                <button
                  title={`Delete ${currency.name}`}
                  onClick={() => removeCurrency(currency)}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="currency-creator">
        <input
          aria-label="New currency name"
          placeholder="Currency (Gold)"
          value={newCurrencyName}
          onChange={(e) => setNewCurrencyName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addCurrency()}
        />
        <input
          aria-label="New currency amount"
          type="number"
          min={0}
          step={1}
          value={newCurrencyAmount}
          onChange={(e) => setNewCurrencyAmount(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addCurrency()}
        />
        <button
          title="Add this currency to the selected character"
          onClick={addCurrency}
          disabled={!newCurrencyName.trim()}
        >
          Add currency
        </button>
      </div>
    </div>
  );
}
