import { useState } from 'react';

// A free-text field with its suggestions always in reach. A native datalist
// filters by what is already typed, so on the default "ally" it shows only that
// one; this opens the whole list on focus and keeps the typed word possible.
export function SuggestionInput({
  label,
  title,
  placeholder,
  value,
  suggestions,
  onChange,
  onEnter,
  onEscape,
  autoFocus,
}: {
  label: string;
  title?: string;
  placeholder?: string;
  value: string;
  suggestions: readonly string[];
  onChange: (value: string) => void;
  onEnter?: () => void;
  onEscape?: () => void;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trimmed = value.trim();
  const options = [
    ...suggestions,
    ...(trimmed && !suggestions.includes(trimmed) ? [trimmed] : []),
  ];

  return (
    <div className="suggestion-field">
      <input
        aria-label={label}
        title={title}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        value={value}
        onChange={event => onChange(event.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={event => {
          if (event.key === 'Enter' && onEnter) onEnter();
          if (event.key === 'Escape' && onEscape) onEscape();
        }}
      />
      {open && options.length > 0 && (
        <div
          className="suggestion-options"
          role="listbox"
          aria-label={`${label} suggestions`}
        >
          {options.map(option => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === trimmed}
              className={option === trimmed ? 'active' : ''}
              // Keeping the focus in the field lets the click land before the
              // list closes on blur.
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
