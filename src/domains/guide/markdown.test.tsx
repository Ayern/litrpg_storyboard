import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import guideSource from '../../../GUIDE.md?raw';
import { renderGuide, slugify } from './markdown';

// The pictures the guide shows, by file name, as the reader would look them up.
const guidePictures = [...new Set(
  [...guideSource.matchAll(/screenshots\/([\w.-]+\.png)/g)].map(match => match[1])
)];
const pictures = Object.fromEntries(guidePictures.map(name => [name, `/assets/${name}`]));

// What the document says, with its code blocks taken out: a fence is quoted
// text, so a `#` or a `|` inside one is not a heading or a table row.
const prose = guideSource.replace(/```[\s\S]*?```/g, '');

const count = (pattern: RegExp, source: string) => [...source.matchAll(pattern)].length;

function draw(source: string, images: Record<string, string> = pictures) {
  const { container } = render(<div>{renderGuide(source, { images })}</div>);
  return container;
}

describe('slugify', () => {
  it('gives a heading the anchor the guide links to', () => {
    expect(slugify('The mental model')).toBe('the-mental-model');
    expect(slugify('1. The mental model')).toBe('1-the-mental-model');
    expect(
      slugify('4. Workflow A — a cast member, a card, and their numbers')
    ).toBe('4-workflow-a--a-cast-member-a-card-and-their-numbers');
    expect(slugify('How the pictures were taken')).toBe('how-the-pictures-were-taken');
  });
});

describe('the renderer', () => {
  it('renders the constructs the guide writes', () => {
    const container = draw(
      [
        '# Title',
        '',
        'A paragraph with **bold**, *slanted* and `code`,',
        'wrapped over two lines.',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
        '',
        '```bash',
        'npm test',
        '```',
        '',
        '---',
      ].join('\n')
    );

    expect(container.querySelector('h1')).toHaveTextContent('Title');
    // A wrapped paragraph is one paragraph, not two.
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.querySelector('p')).toHaveTextContent(
      'A paragraph with bold, slanted and code, wrapped over two lines.'
    );
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('slanted');
    expect(container.querySelector('code')).toHaveTextContent('code');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
    expect(container.querySelector('pre code')).toHaveTextContent('npm test');
    expect(container.querySelector('hr')).toBeInTheDocument();
  });

  it('renders a table with its header and rows', () => {
    const container = draw(
      ['| Command | What it does |', '| --- | --- |', '| `npm test` | the suite |'].join('\n')
    );

    expect(container.querySelectorAll('table th')).toHaveLength(2);
    expect(container.querySelectorAll('table tbody tr')).toHaveLength(1);
    const cells = [...container.querySelectorAll('tbody td')];
    expect(cells[0]).toHaveTextContent('npm test');
    expect(cells[1]).toHaveTextContent('the suite');
    // The row of dashes is syntax, not a row of the table.
    expect(container.querySelectorAll('tr')).toHaveLength(2);
  });

  it('tells the three kinds of link apart', () => {
    const container = draw(
      'See [the source](src/App.tsx), [the notes](#the-mental-model) and [the README](https://example.com/x).'
    );

    const source = container.querySelector('.guide-path');
    expect(source).toHaveTextContent('the source');
    expect(source).toHaveAttribute('title', 'In the repository: src/App.tsx');

    const anchor = container.querySelector('a.guide-anchor');
    expect(anchor).toHaveAttribute('href', '#the-mental-model');

    const external = container.querySelector('a[href^="https://"]');
    expect(external).toHaveTextContent('the README');
    expect(external).toHaveAttribute('rel', 'noreferrer');
  });

  it('shows a picture the bundle knows and names the one it does not', () => {
    const container = draw(
      '![The board](screenshots/canvas-board.png) ![Gone](screenshots/gone.png)',
      { 'canvas-board.png': '/assets/canvas-board.png' }
    );

    expect(container.querySelector('img')).toHaveAttribute('src', '/assets/canvas-board.png');
    expect(container.querySelector('img')).toHaveAttribute('alt', 'The board');
    // A missing file is named rather than left as an empty space.
    expect(container.querySelector('.guide-missing-image')).toHaveTextContent('Gone');
  });
});

describe('GUIDE.md', () => {
  it('renders every heading, rule, code block and table it has', () => {
    const container = draw(guideSource);

    expect(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).toHaveLength(
      count(/^#{1,6} /gm, prose)
    );
    expect(container.querySelectorAll('hr')).toHaveLength(count(/^-{3,}\s*$/gm, prose));
    expect(container.querySelectorAll('pre')).toHaveLength(count(/^```/gm, guideSource) / 2);

    // Every table the document draws, each with as many cells per row as its
    // header has columns.
    const tables = [...container.querySelectorAll('table')];
    const columns = tables.map(table => table.querySelectorAll('th').length);

    expect(tables.length).toBeGreaterThan(0);

    for (const [index, table] of tables.entries()) {
      expect(columns[index]).toBeGreaterThan(0);

      for (const row of table.querySelectorAll('tbody tr')) {
        expect(row.querySelectorAll('td')).toHaveLength(columns[index]);
      }
    }
  });

  it('shows every picture it embeds, from the bundle', () => {
    const container = draw(guideSource);
    const images = [...container.querySelectorAll('img')];

    expect(images).toHaveLength(count(/!\[[^\]]*\]\([^)]+\)/g, prose));

    for (const image of images) {
      expect(image.getAttribute('src')).toMatch(/^\/assets\//);
    }

    // Nothing was left as a bare file name.
    expect(container.querySelector('.guide-missing-image')).not.toBeInTheDocument();
  });

  it('resolves every link its contents list makes', () => {
    const container = draw(guideSource);
    const anchors = [...prose.matchAll(/\]\(#([^)]+)\)/g)].map(match => match[1]);

    expect(anchors.length).toBeGreaterThan(0);

    for (const slug of anchors) {
      expect(
        container.querySelector(`[data-guide-anchor="${slug}"]`),
        `the guide links to #${slug}, which is not one of its headings`
      ).toBeInTheDocument();
    }
  });

  it('leaves no Markdown syntax in the text it draws', () => {
    const container = draw(guideSource);
    const text = container.textContent ?? '';

    // If any of these survive into the text, the reader has a construct it does
    // not understand and is showing the reader its own source. (A picture's
    // path is fine: the guide's checklist table names each file in a code span,
    // which is text the document asked for.)
    expect(text).not.toContain('**');
    expect(text).not.toContain('](');
    expect(text).not.toContain('![');
    expect(text).not.toContain('```');
  });
});
