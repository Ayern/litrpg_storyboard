import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AttributeList } from './AttributeList';
import type { AttributeListProps } from './AttributeList';
import type { CharacterAttribute } from './types';

// The attribute rows are a pure view around their own form state: the rows and
// the callbacks arrive as props, and everything the author types stays in here
// until a write answers whether it happened. These tests render the panel
// directly and hold it to both halves - the drafts it keeps and the writes it
// asks the app for - without a sheet, a story or a database.

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
    onError: vi.fn(),
    onCreate: vi.fn(async () => true),
    onSave: vi.fn(async () => true),
    onDelete: vi.fn(async () => true),
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

  it('shows each name with its value, and opens one for editing with its value', async () => {
    const user = userEvent.setup();
    const aura = attribute('a-1', 'Aura', 'Frost');

    render(<AttributeList {...baseProps({ attributes: [aura] })} />);

    expect(screen.getByText('Aura')).toBeInTheDocument();
    expect(screen.getByText('Frost')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByDisplayValue('Frost')).toBeInTheDocument();
  });

  it('saves the value it was typed, and closes the row once the app says so', async () => {
    const user = userEvent.setup();
    const aura = attribute('a-1', 'Aura', 'Frost');
    const onSave = vi.fn(async () => true);

    render(
      <AttributeList {...baseProps({ attributes: [aura], onSave })} />
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByDisplayValue('Frost');
    await user.clear(field);
    await user.type(field, 'Ember');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(aura, 'Ember');
    expect(screen.queryByDisplayValue('Ember')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('will not save a blank value, and keeps the row open when a save is refused', async () => {
    const user = userEvent.setup();
    const aura = attribute('a-1', 'Aura', 'Frost');
    const onSave = vi.fn(async () => false);
    const onError = vi.fn();

    render(
      <AttributeList {...baseProps({ attributes: [aura], onSave, onError })} />
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByDisplayValue('Frost'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'An attribute needs a value — delete it to remove it.'
    );

    await user.type(screen.getByRole('button', { name: 'Cancel' }), '{esc}');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByDisplayValue('Frost');
    await user.clear(field);
    await user.type(field, 'Ember');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(aura, 'Ember');
    expect(screen.getByDisplayValue('Ember')).toBeInTheDocument();
  });

  it('asks to delete the row it names', async () => {
    const user = userEvent.setup();
    const aura = attribute('a-1', 'Aura', 'Frost');
    const onDelete = vi.fn(async () => true);

    render(<AttributeList {...baseProps({ attributes: [aura], onDelete })} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onDelete).toHaveBeenCalledWith(aura);
  });

  it('holds the add back until a name and a value are both typed, then clears both', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => true);

    render(<AttributeList {...baseProps({ onCreate })} />);

    const add = screen.getByRole('button', { name: 'Add attribute' });
    expect(add).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Attribute (Class)'), 'Class');
    expect(add).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Value (Rogue)'), 'Rogue');
    await user.click(add);

    expect(onCreate).toHaveBeenCalledWith('Class', 'Rogue');
    expect(screen.getByPlaceholderText('Attribute (Class)')).toHaveValue('');
    expect(screen.getByPlaceholderText('Value (Rogue)')).toHaveValue('');
  });

  it('treats a whitespace value as no value, and keeps what was typed when the app says no', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => false);

    render(<AttributeList {...baseProps({ onCreate })} />);

    await user.type(screen.getByPlaceholderText('Attribute (Class)'), 'Class');
    await user.type(screen.getByPlaceholderText('Value (Rogue)'), '   ');

    expect(screen.getByRole('button', { name: 'Add attribute' })).toBeDisabled();

    await user.clear(screen.getByPlaceholderText('Value (Rogue)'));
    await user.type(screen.getByPlaceholderText('Value (Rogue)'), 'Rogue');
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));

    expect(onCreate).toHaveBeenCalledWith('Class', 'Rogue');
    expect(screen.getByPlaceholderText('Attribute (Class)')).toHaveValue('Class');
    expect(screen.getByPlaceholderText('Value (Rogue)')).toHaveValue('Rogue');
  });
});
