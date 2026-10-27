import { formatCount } from '../../lib/format';
import type { CharacterCurrency } from '../inventory/types';

// The sheet's currency: a named amount per character. Nothing adds up across
// names, so gold and mana crystals stay separate rows rather than one balance,
// and each row is written on its own.
//
// The open row's id and the two drafts stay in the app beside the writes they
// feed, so an add, a save and a delete keep their single audited step.

export interface CurrencyListProps {
  currencies: CharacterCurrency[];
  editingCurrencyId: string | null;
  setEditingCurrencyId: (currencyId: string | null) => void;
  currencyNameDraft: string;
  setCurrencyNameDraft: (name: string) => void;
  currencyAmountDraft: string;
  setCurrencyAmountDraft: (amount: string) => void;
  startCurrencyEdit: (currency: CharacterCurrency) => void;
  saveCurrency: (currency: CharacterCurrency) => Promise<void>;
  removeCurrency: (currency: CharacterCurrency) => Promise<void>;
  newCurrencyName: string;
  setNewCurrencyName: (name: string) => void;
  newCurrencyAmount: string;
  setNewCurrencyAmount: (amount: string) => void;
  addCurrency: () => Promise<void>;
}

export function CurrencyList({
  currencies,
  editingCurrencyId,
  setEditingCurrencyId,
  currencyNameDraft,
  setCurrencyNameDraft,
  currencyAmountDraft,
  setCurrencyAmountDraft,
  startCurrencyEdit,
  saveCurrency,
  removeCurrency,
  newCurrencyName,
  setNewCurrencyName,
  newCurrencyAmount,
  setNewCurrencyAmount,
  addCurrency,
}: CurrencyListProps) {
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
