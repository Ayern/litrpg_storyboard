import { afterAll, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { GuideReader } from './GuideReader';

// jsdom has no layout, so there is nothing for it to scroll. The reader asks for
// the jump anyway; this stands in so the suite can check that it did, and which
// heading it asked for.
const scrolled: string[] = [];
const originalScroll = Element.prototype.scrollIntoView;

Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
  scrolled.push((this as HTMLElement).dataset.guideAnchor ?? '(no anchor)');
};

afterAll(() => {
  Element.prototype.scrollIntoView = originalScroll;
});

const shortGuide = [
  '# How It Works',
  '',
  '## 1. The mental model',
  '',
  'A line you draw is a record.',
  '',
  '![The board](screenshots/canvas-board.png)',
  '',
  '## 9. Visual asset checklist',
].join('\n');

function open(overrides: Partial<Parameters<typeof GuideReader>[0]> = {}) {
  const onClose = vi.fn();
  const onOpenShortcuts = vi.fn();

  render(
    <GuideReader
      onClose={onClose}
      onOpenShortcuts={onOpenShortcuts}
      source={shortGuide}
      images={{ 'canvas-board.png': '/assets/canvas-board.png' }}
      {...overrides}
    />
  );

  return { onClose, onOpenShortcuts, dialog: screen.getByRole('dialog', { name: 'Guide' }) };
}

describe('the guide reader', () => {
  it('shows the document, pictures included', () => {
    const { dialog } = open();

    expect(within(dialog).getByRole('heading', { name: 'How It Works' })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('heading', { name: '1. The mental model' })
    ).toBeInTheDocument();

    const picture = within(dialog).getByRole('img', { name: 'The board' });
    expect(picture).toHaveAttribute('src', '/assets/canvas-board.png');
  });

  it('follows a contents link to its heading and takes the focus with it', () => {
    scrolled.length = 0;

    const { dialog } = open({
      source: [
        '## Contents',
        '',
        '1. [The mental model](#1-the-mental-model)',
        '',
        '## 1. The mental model',
        '',
        'A line you draw is a record.',
      ].join('\n'),
    });

    fireEvent.click(within(dialog).getByRole('link', { name: 'The mental model' }));

    expect(scrolled).toEqual(['1-the-mental-model']);
    // A keyboard reader lands on the heading rather than back at the top.
    expect(document.activeElement).toHaveAttribute('data-guide-anchor', '1-the-mental-model');
  });

  it('closes from its button, from Escape’s button and from the backdrop', () => {
    const { onClose, dialog } = open();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close guide' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clicking the document itself is not a dismissal.
    fireEvent.click(within(dialog).getByRole('heading', { name: 'How It Works' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('hands over to the keyboard reference', () => {
    const { onOpenShortcuts, dialog } = open();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keyboard shortcuts' }));

    expect(onOpenShortcuts).toHaveBeenCalledTimes(1);
  });

  it('reads the repository’s author guide when it is given nothing else', () => {
    // The default source is `STORYBOARDING.md` itself: the app has no copy of it,
    // and the document the header's button opens is the author's one.
    render(<GuideReader onClose={() => {}} onOpenShortcuts={() => {}} />);

    const dialog = screen.getByRole('dialog', { name: 'Guide' });

    expect(
      within(dialog).getByRole('heading', { name: 'Storyboarding a story' })
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: '1. Get a story open' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: '13. A short reference' })).toBeInTheDocument();

    // The pictures come from the bundle, not from the repository's folder.
    expect(within(dialog).getAllByRole('img').length).toBeGreaterThan(0);
  });
});
