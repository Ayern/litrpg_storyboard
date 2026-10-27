import type { ReactNode } from 'react';

// A small Markdown reader, sized to the one document it has to render: GUIDE.md.
//
// The guide is not displayed anywhere else, so this is deliberately not a
// Markdown library. It understands exactly what that file uses — headings,
// paragraphs, bullet and numbered lists, tables, fenced code, rules, and bold,
// italic, code, links and pictures inline — and its suite renders the real
// GUIDE.md and checks that nothing else turned up in it. A construct the guide
// grows that this file does not know would show as its own source text, which is
// what those tests look for.
//
// Pictures are looked up by file name in the map the reader passes: the guide
// links `screenshots/board.png`, and the app's bundle holds that file under a
// hashed name, so the two are joined here rather than in the document.

export interface GuideRenderOptions {
  // Bundle URLs by file name, for the pictures the guide embeds.
  images?: Record<string, string>;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

// The anchor GitHub gives a heading, which is what the guide's own contents list
// links to: lower case, punctuation dropped, each space turned into a hyphen.
//
// One space at a time, not runs of them: dropping the em dash from "Workflow A —
// a cast member" leaves two spaces behind, and the anchor the guide links to is
// "workflow-a--a-cast-member" with both hyphens in it.
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

const headingPattern = /^(#{1,6})\s+(.*)$/;
const rulePattern = /^(-{3,}|\*{3,})\s*$/;
const bulletPattern = /^\s*[-*]\s+(.*)$/;
const numberedPattern = /^\s*\d+\.\s+(.*)$/;

function isTableStart(line: string): boolean {
  return line.trimStart().startsWith('|');
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

function isSeparator(line: string): boolean {
  return /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes('-');
}

// Whether a line begins a block of its own, which is where a paragraph ends.
function startsBlock(line: string): boolean {
  return (
    headingPattern.test(line) ||
    rulePattern.test(line) ||
    bulletPattern.test(line) ||
    numberedPattern.test(line) ||
    isTableStart(line) ||
    line.trimStart().startsWith('```')
  );
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith('```')) {
      const body: string[] = [];
      index += 1;

      while (index < lines.length && !lines[index].trimStart().startsWith('```')) {
        body.push(lines[index]);
        index += 1;
      }

      index += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = headingPattern.exec(line);

    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (rulePattern.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    if (isTableStart(line)) {
      const start = index;

      while (index < lines.length && isTableStart(lines[index])) index += 1;

      const rows = lines.slice(start, index).map(cells);
      const [header, ...body] = rows;
      blocks.push({
        kind: 'table',
        header,
        // The row of dashes under the header is the table's syntax, not a row.
        rows: body.filter(row => !isSeparator(row.join('|'))),
      });
      continue;
    }

    const bullet = bulletPattern.exec(line);
    const numbered = bullet ? null : numberedPattern.exec(line);

    if (bullet || numbered) {
      const ordered = numbered !== null;
      const items: string[] = [];
      let match = bulletPattern.exec(lines[index]) ?? numberedPattern.exec(lines[index]);

      while (index < lines.length && match) {
        items.push(match[1].trim());
        index += 1;
        match = ordered ? numberedPattern.exec(lines[index]) : bulletPattern.exec(lines[index]);
      }

      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];

    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }

    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

// The characters that can open something inline. Anything else is text, which
// is what keeps a lone `*` or `[` from swallowing the rest of a paragraph.
const inlineStart = /[`*[!]/;

function renderInline(text: string, options: GuideRenderOptions, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let literal = '';
  let index = 0;
  let key = 0;

  const flush = () => {
    if (literal) {
      nodes.push(literal);
      literal = '';
    }
  };

  const push = (node: ReactNode) => {
    flush();
    nodes.push(node);
  };

  while (index < text.length) {
    const rest = text.slice(index);

    if (rest[0] === '`') {
      const end = rest.indexOf('`', 1);

      if (end > 0) {
        push(<code key={`${keyPrefix}-code-${key++}`}>{rest.slice(1, end)}</code>);
        index += end + 1;
        continue;
      }
    }

    const image = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(rest);

    if (image) {
      const [, alt, source] = image;
      const file = source.split('/').pop() ?? source;
      const url = options.images?.[file];

      push(
        url ? (
          <img key={`${keyPrefix}-img-${key++}`} src={url} alt={alt} loading="lazy" />
        ) : (
          <span key={`${keyPrefix}-missing-${key++}`} className="guide-missing-image">
            {alt} ({source})
          </span>
        )
      );

      index += image[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(rest);

    if (link) {
      const [, label, href] = link;

      if (href.startsWith('#')) {
        push(
          <a key={`${keyPrefix}-anchor-${key++}`} href={href} className="guide-anchor">
            {label}
          </a>
        );
      } else if (/^https?:/.test(href)) {
        push(
          <a key={`${keyPrefix}-link-${key++}`} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        );
      } else {
        // A path inside the repository. The app cannot open the working copy, so
        // the name is shown as it is written rather than as a link that would do
        // nothing when clicked.
        push(
          <span key={`${keyPrefix}-path-${key++}`} className="guide-path" title={`In the repository: ${href}`}>
            {label}
          </span>
        );
      }

      index += link[0].length;
      continue;
    }

    if (rest.startsWith('**')) {
      const end = rest.indexOf('**', 2);

      if (end > 1) {
        push(
          <strong key={`${keyPrefix}-bold-${key++}`}>
            {renderInline(rest.slice(2, end), options, `${keyPrefix}-b${key}`)}
          </strong>
        );
        index += end + 2;
        continue;
      }
    }

    if (rest[0] === '*') {
      const end = rest.indexOf('*', 1);

      if (end > 0) {
        push(
          <em key={`${keyPrefix}-em-${key++}`}>
            {renderInline(rest.slice(1, end), options, `${keyPrefix}-e${key}`)}
          </em>
        );
        index += end + 1;
        continue;
      }
    }

    const next = rest.slice(1).search(inlineStart);

    if (next === -1) {
      literal += rest;
      break;
    }

    literal += rest.slice(0, next + 1);
    index += next + 1;
  }

  flush();

  return nodes;
}

function renderBlock(block: Block, index: number, options: GuideRenderOptions): ReactNode {
  const key = `guide-block-${index}`;

  switch (block.kind) {
    case 'heading': {
      const level = Math.min(block.level, 6) as 1 | 2 | 3 | 4 | 5 | 6;
      const Heading = `h${level}` as 'h1';

      return (
        <Heading key={key} data-guide-anchor={slugify(block.text)}>
          {renderInline(block.text, options, key)}
        </Heading>
      );
    }

    case 'paragraph':
      return <p key={key}>{renderInline(block.text, options, key)}</p>;

    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';

      return (
        <List key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInline(item, options, `${key}-${itemIndex}`)}</li>
          ))}
        </List>
      );
    }

    case 'table':
      return (
        <table key={key}>
          <thead>
            <tr>
              {block.header.map((cell, cellIndex) => (
                <th key={`${key}-h${cellIndex}`}>{renderInline(cell, options, `${key}-h${cellIndex}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-r${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`${key}-r${rowIndex}-${cellIndex}`}>
                    {renderInline(cell, options, `${key}-r${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );

    case 'code':
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      );

    case 'rule':
      return <hr key={key} />;
  }
}

// The whole document, as elements. A block this file does not understand would
// come out as its own source text, so the suite renders GUIDE.md and looks for
// the syntax the guide does not use.
export function renderGuide(source: string, options: GuideRenderOptions = {}): ReactNode[] {
  return parseBlocks(source).map((block, index) => renderBlock(block, index, options));
}
