import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AttributeList } from './AttributeList';
import type { AttributeListProps } from './AttributeList';
import type { CharacterAttribute } from './types';

// The attribute rows are the one part of the sheet with no test of their own:
// adding, changing and deleting an attribute is only ever reached through the
// canvas command mocks in other suites. They are a pure view - every answer and
// every write arrives as a prop - so they are rendered directly and the writes
// are asserted rather than the state behind them.

function attribute(id: string, name: string, value: string): CharacterAttribute {
  return {
    id,
    character_id: 'c-1',
    attr_name: name,
    value,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function baseProps(
  overrides: Partial<AttributeListProps> = {}
): AttributeListProps {
  return {
    attributes: [],
    editingAttributeId: null,
    setEditingAttributeId: vi.fn(),
    attributeValueDraft: '',
    setAttributeValueDraft: vi.fn(),
    startAttributeEdit: vi.fn(),
    saveAttribute: vi.fn(async () => {}),
    removeAttribute: vi.fn(async () => {}),
    newAttributeName: '',
    setNewAttributeName: vi.fn(),
    newAttributeValue: '',
    setNewAttributeValue: vi.fn(),
    addAttribute: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('the attribute rows', () => {
  it('says what an empty sheet is missing', () => {
    render(<AttributeList {...baseProps()} />);

    expect(
      screen.getByText('No attributes yet — Class, Title, Aura, Affinity.')
    ).toBeInTheDocument();
  });

  it('shows each name with its value, and asks to open one for editing', async () => {
    const user = userEvent.setup();
    const aura = attribute('a-1', 'Aura', 'Frost');
    const startAttributeEdit = vi.fn();

    render(
      <AttributeList
        {...baseProps({ attributes: [aura], startAttributeEdit })}
      />
    );

    expect(screen.getByText('Aura')).toBeInTheDocument();
    expect(screen.getByText('Frost')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(startAttributeEdit).toHaveBeenCalledWith(aura);
  });

  it('edits the open row against its draft and saves it', async () => {
    const user = userEvent.setup();
    const aura = attribute('a-1', 'Aura', 'Frost');
    const setAttributeValueDraft = vi.fn();
    const saveAttribute = vi.fn(async () => {});
    const setEditingAttributeId = vi.fn();

    render(
      <AttributeList
        {...baseProps({
          attributes: [aura],
          editingAttributeId: 'a-1',
          attributeValueDraft: 'Frost',
          setAttributeValueDraft,
          saveAttribute,
          setEditingAttributeId,
        })}
      />
    );

    await user.type(screen.getByDisplayValue('Frost'), '!');
    expect(setAttributeValueDraft).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveAttribute).toHaveBeenCalledWith(aura);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(setEditingAttributeId).toHaveBeenCalledWith(null);
  });

  it('asks to delete the row it names', async () => {
    const user = userEvent.setup();
    const aura = attribute('a-1', 'Aura', 'Frost');
    const removeAttribute = vi.fn(async () => {});

    render(
      <AttributeList {...baseProps({ attributes: [aura], removeAttribute })} />
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(removeAttribute).toHaveBeenCalledWith(aura);
  });

  it('holds the add back until a name and a value are both typed', async () => {
    const user = userEvent.setup();
    const setNewAttributeName = vi.fn();
    const setNewAttributeValue = vi.fn();
    const addAttribute = vi.fn(async () => {});

    const { rerender } = render(
      <AttributeList
        {...baseProps({ setNewAttributeName, setNewAttributeValue, addAttribute })}
      />
    );

    expect(screen.getByRole('button', { name: 'Add attribute' })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Attribute (Class)'), 'Class');
    expect(setNewAttributeName).toHaveBeenCalled();

    // The name alone is not enough: an attribute needs a value too.
    rerender(
      <AttributeList
        {...baseProps({
          newAttributeName: 'Class',
          setNewAttributeName,
          setNewAttributeValue,
          addAttribute,
        })}
      />
    );
    expect(screen.getByRole('button', { name: 'Add attribute' })).toBeDisabled();

    rerender(
      <AttributeList
        {...baseProps({
          newAttributeName: 'Class',
          newAttributeValue: 'Rogue',
          setNewAttributeName,
          setNewAttributeValue,
          addAttribute,
        })}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));

    expect(addAttribute).toHaveBeenCalled();
  });
});
