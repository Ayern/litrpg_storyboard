import { useMemo, useRef, type MouseEvent } from 'react';

import authorGuide from '../../../STORYBOARDING.md?raw';

import { renderGuide } from './markdown';

// The guide the header's Guide button opens: `STORYBOARDING.md`, read inside the
// app instead of in an editor beside it, pictures included.
//
// That is the author's document — what to click, in what order, to plot a story.
// `GUIDE.md`, the developer's document, is not shown here: it is about the code,
// and its first page sends a reader who wants to use the app to this one.
//
// There is one document, not two. The app imports the repository's file at build
// time, so the guide a reader opens here is the guide the repository keeps, and
// the pictures it shows are the files `npm run screenshots` writes into
// `screenshots/` — the same run that checks each document's list of pictures
// against the ones it shot.

// Three levels up: this file is `src/domains/guide/`, and the gallery sits at the
// top of the project beside the guide it illustrates.
const bundledPictures = import.meta.glob('../../../screenshots/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

// Keyed by file name, because a file name is how the guide links a picture
// (`screenshots/canvas-board.png`); the bundle knows it under a hashed path.
const pictures: Record<string, string> = Object.fromEntries(
  Object.entries(bundledPictures).map(([path, url]) => [path.split('/').pop() ?? path, url])
);

export interface GuideReaderProps {
  onClose: () => void;
  onOpenShortcuts: () => void;
  // The document and its pictures both default to the repository's author guide.
  // A test passes a shorter document and its own picture map.
  source?: string;
  images?: Record<string, string>;
}

export function GuideReader({
  onClose,
  onOpenShortcuts,
  source = authorGuide,
  images = pictures,
}: GuideReaderProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const content = useMemo(() => renderGuide(source, { images }), [source, images]);

  // The guide's contents list links to its own headings, and a jump out of the
  // dialog would lose the reader's place, so the link is followed here. Focus
  // moves with it, or a keyboard reader would be left at the top of the page
  // they just left.
  const followAnchor = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as HTMLElement).closest?.('a[href^="#"]') as HTMLAnchorElement | null;

    if (!link) return;

    event.preventDefault();

    const slug = decodeURIComponent(link.getAttribute('href')?.slice(1) ?? '');
    const heading = bodyRef.current?.querySelector<HTMLElement>(`[data-guide-anchor="${slug}"]`);

    if (!heading) return;

    heading.scrollIntoView?.({ block: 'start' });
    heading.tabIndex = -1;
    heading.focus();
  };

  return (
    <div className={'shortcuts-backdrop'} role="presentation" onClick={onClose}>
      <div
        className="shortcuts guide-reader"
        role="dialog"
        aria-modal="true"
        aria-label="Guide"
        onClick={event => event.stopPropagation()}
      >
        <div className="shortcuts-head">
          <h2>Guide</h2>
          <button
            className="shortcuts-close"
            aria-label="Close guide"
            title="Close this guide (Esc)"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <p className="shortcuts-intro">
          Using the app, start to finish, pictures included: the same document the repository keeps
          in STORYBOARDING.md. How it works underneath is GUIDE.md, for whoever changes the app.
        </p>

        <div className="guide-reader-body" ref={bodyRef} onClick={followAnchor}>
          {content}
        </div>

        <div className="guide-actions">
          <button
            type="button"
            title="Show every keyboard route"
            onClick={onOpenShortcuts}
          >
            Keyboard shortcuts
          </button>
          <button type="button" title="Close this guide" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
