#!/usr/bin/env node
// Regenerates the guide's sample story and re-shoots every picture in it.
//
//   npm run screenshots                 # the fixture, then all twenty-two images
//   npm run screenshots -- --no-fixture # images only, from the fixture on disk
//   npm run fixture                     # the fixture only, no images
//
// The pictures are of the app, so this drives the app: it starts the harness
// server (the real `src/App.tsx`, Tauri's commands answered from
// `backend.ts`), walks the twenty-two anchor states in order, and writes each one
// into `screenshots/`. A step that cannot be reached fails the run rather than
// quietly writing a picture of the wrong screen.
//
// The run ends by comparing the pictures it shot with the ones `GUIDE.md` shows,
// and fails if the two lists differ: a picture the guide shows that nothing shot
// is a stale file, and one in `screenshots/` that no page shows is a leftover
// from an anchor that has moved on. That comparison is what keeps the gallery
// from drifting from the app it documents.
//
// A browser is needed, and not downloaded: `playwright-core` drives one that is
// already installed. `SCREENSHOTS_BROWSER` names it outright if none of the
// usual ones is found.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const outDir = path.join(root, 'screenshots');
const fixturePath = path.join(here, 'fixture.json');

// Every picture this run writes, so the gallery can be checked against the guide
// at the end rather than assumed to be in step with it.
const written = new Set();

const argv = new Set(process.argv.slice(2));
const port = Number(process.env.SCREENSHOTS_PORT ?? 5188);
const base = `http://127.0.0.1:${port}/`;
const viewport = { width: 1600, height: 1000 };
// The zoom the whole-web picture is taken at: near the scale the board is drawn
// at, so the names inside the cards can be read in the picture.
const READABLE_ZOOM = 0.7;

const log = message => console.log(message);
const fail = message => {
  throw new Error(message);
};

// ---- the two things that have to exist before a picture can be taken -----

function buildFixture() {
  log('· writing the sample story');

  const result = spawnSync(
    'cargo',
    [
      'run',
      '-q',
      '-p',
      'litrpg-db',
      '--example',
      'screenshot_fixture',
      '--',
      fixturePath,
    ],
    { cwd: path.join(root, 'src-tauri'), stdio: 'inherit', shell: false }
  );

  if (result.error) {
    fail(
      `could not run cargo (${result.error.message}). Install a Rust toolchain, ` +
        'or pass --no-fixture to shoot the story already in fixture.json.'
    );
  }

  if (result.status !== 0) fail(`the fixture example exited with ${result.status}`);
}

async function startServer() {
  log(`· starting the harness on port ${port}`);

  const child = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--config',
      path.join(here, 'vite.config.ts'),
      '--port',
      String(port),
      '--strictPort',
      // Bound to the loopback address the readiness check polls, rather than to
      // whatever `localhost` resolves to on this machine.
      '--host',
      '127.0.0.1',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));

  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`the harness server exited early:\n${output}`);

    try {
      const response = await fetch(base);
      if (response.ok) return child;
    } catch {
      // Not listening yet.
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  fail(`the harness server did not answer on ${base} within 30s:\n${output}`);
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function launchBrowser() {
  const attempts = [];

  if (process.env.SCREENSHOTS_BROWSER) {
    attempts.push({ executablePath: process.env.SCREENSHOTS_BROWSER });
  }

  for (const channel of ['msedge', 'chrome', 'chromium']) attempts.push({ channel });

  for (const candidate of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    attempts.push({ executablePath: candidate });
  }

  const tried = [];

  for (const options of attempts) {
    try {
      const browser = await chromium.launch(options);
      log(`· shooting with ${browser.version()}`);
      return browser;
    } catch (error) {
      tried.push(String(error).split('\n')[0]);
    }
  }

  fail(
    'no browser could be launched. Set SCREENSHOTS_BROWSER to an installed ' +
      `Chrome, Edge or Chromium.\n${tried.join('\n')}`
  );
}

// ---- the walk through the app -------------------------------------------

// The scale React Flow is drawing at, read off the viewport it transforms, so a
// step can ask for a zoom rather than count clicks whose ratio could change.
async function boardZoom(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('.react-flow__viewport');
    if (!viewport) return 0;

    return new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
  });
}

// Zooms in on a named card, where the pointer is: the board grows around the
// point under the cursor, so the card stays where it is on screen while the rest
// of the web opens out below and to the right of it. That is how a person frames
// a picture of one corner of the board, and it needs no panning.
async function zoomOnCard(page, cardId, target, anchor = { x: 12, y: 12 }) {
  const card = await page.locator(`.react-flow__node[data-id="${cardId}"]`).boundingBox();
  if (!card) fail('the card the layers picture is framed on is not on the board');

  // The point that does not move while the board grows: down and in from the
  // card's corner, which opens the picture out to the right and leaves the card
  // near the top of it.
  await page.mouse.move(Math.round(card.x + anchor.x), Math.round(card.y + anchor.y));

  for (let step = 0; step < 60; step += 1) {
    if ((await boardZoom(page)) >= target) return;

    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(60);
  }

  if ((await boardZoom(page)) < target) {
    fail('the board would not zoom in far enough to read the cards in the picture');
  }
}

async function capture(page, name) {
  await page.screenshot({ path: path.join(outDir, name) });
  written.add(name);
  log(`  ${name}`);
}

// Nudges the board by dragging empty canvas, so a card near the corner is not
// photographed under the legend. The point to grab is found rather than guessed:
// the first place over the pane itself, which is the board's own background.
async function panBoard(page, dx, dy) {
  const point = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) return null;

    const rect = pane.getBoundingClientRect();

    for (let y = rect.top + 80; y < rect.bottom - 80; y += 40) {
      for (let x = rect.left + 80; x < rect.right - 80; x += 60) {
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) {
          return { x: Math.round(x), y: Math.round(y) };
        }
      }
    }

    return null;
  });

  if (!point) fail('the board had no empty canvas to pan by');

  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

async function shoot(page, fixture) {
  const story = fixture.storyId;
  const node = (label, type) => {
    const found = fixture.nodes.find(
      entry => entry.label === label && (!type || entry.node_type === type)
    );
    return found ? found.id : fail(`the fixture has no card labelled "${label}"`);
  };
  const edge = label => {
    const found = fixture.edges.find(entry => entry.label === label);
    return found ? found.id : fail(`the fixture has no connection labelled "${label}"`);
  };

  const chat = message => `the app never reached a state this script needs: ${message}`;

  // The board is drawn from the story, so waiting for its cards is waiting for
  // the app to be ready. It opens on the chapter spine, so the chapters are what
  // there is to wait for: the other cards are on layers that are switched off.
  await page.waitForSelector('.react-flow__node', { timeout: 20_000 });
  await page.waitForFunction(
    count => document.querySelectorAll('.react-flow__node').length >= count,
    fixture.nodes.filter(
      entry => entry.parent_node_id === null && entry.node_type === 'chapter'
    ).length,
    { timeout: 20_000 }
  );

  // 1. The first-run card, before anything is dismissed.
  await capture(page, 'onboarding-welcome.png');
  await page.getByRole('button', { name: 'Got it' }).click();

  // 2. The whole board, framed so every card is inside the picture.
  //
  // The frame is asked for twice: a chapter card grows as its objectives and
  // its event log draw, so the first fit measures the cards before their faces
  // have their full height. The second one is taken after they have settled.
  await page.getByRole('button', { name: 'fit view' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'fit view' }).click();
  await page.waitForTimeout(700);
  await capture(page, 'canvas-board.png');

  // The chapter card's + Event form, on the two kinds that change a skill: the
  // character's own rows in the Skill picker, the evolved name and the
  // keep-base toggle, then the sacrifice record toggle on a clerk's skill.
  const eventCard = page.locator(
    `.react-flow__node[data-id="${node('The Ninth Bell', 'chapter')}"]`
  );

  await eventCard.getByRole('button', { name: '+ Event' }).click();
  await eventCard
    .getByRole('combobox', { name: 'Event type in The Ninth Bell' })
    .selectOption('skill_evolve');
  await eventCard
    .getByRole('combobox', { name: 'Skill the event changes in The Ninth Bell' })
    .selectOption({ label: 'Deep Bell' });
  await eventCard
    .getByRole('textbox', { name: 'Detail of the event in The Ninth Bell' })
    .fill('Hollow Bell');
  await capture(page, 'chapter-event-evolve.png');
  await eventCard.getByRole('button', { name: 'Cancel' }).click();

  await eventCard.getByRole('button', { name: '+ Event' }).click();
  await eventCard
    .getByRole('combobox', { name: 'Who the event happens to in The Ninth Bell' })
    .selectOption({ label: 'Tamsin Quill' });
  await eventCard
    .getByRole('combobox', { name: 'Event type in The Ninth Bell' })
    .selectOption('skill_sacrifice');
  // The picker names a rank where the sheet has one, so this one is chosen by
  // its place: the clerk's rows are Ledger Sight, then the skill she gives up.
  await eventCard
    .getByRole('combobox', { name: 'Skill the event changes in The Ninth Bell' })
    .selectOption({ index: 0 });
  await capture(page, 'chapter-event-sacrifice.png');
  await eventCard.getByRole('button', { name: 'Cancel' }).click();

  // The same board with every layer drawn: one press, then the frame asked for
  // twice again, because the cards that appear are drawn at their own sizes and
  // a card is measured a frame after it is first drawn. Waiting for the count is
  // waiting for the board to have every card on it before anything is framed.
  // The rest of the walk happens with the whole web on screen.
  await page.getByRole('button', { name: 'Show all' }).click();
  await page.waitForFunction(
    count => document.querySelectorAll('.react-flow__node').length >= count,
    fixture.nodes.filter(entry => entry.parent_node_id === null).length,
    { timeout: 20_000 }
  );
  await page.waitForTimeout(1_200);
  await page.getByRole('button', { name: 'fit view' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'fit view' }).click();
  await page.waitForTimeout(600);

  // Two pictures of the same board, because the two things a reader needs from
  // it cannot be in one: the whole web at once is a map, and at that scale the
  // words inside a card are four pixels tall and nothing can be read. So the map
  // first, with every tier inside the frame, one step back from the frame so the
  // corner key sits beside the cards at the bottom rather than over them...
  await page.getByRole('button', { name: 'zoom out' }).click();
  await page.waitForTimeout(500);
  await capture(page, 'canvas-web.png');

  // ...and then the top of the same board the way somebody would look at it,
  // zoomed until the cards can be read, with the lower tiers off the picture.
  await zoomOnCard(page, node('The Low Tide', 'chapter'), READABLE_ZOOM, { x: 100, y: 20 });
  await page.waitForTimeout(600);
  await capture(page, 'canvas-layers.png');

  // Back to the frame for the rest of the walk: every later step clicks a card,
  // and a card off the picture cannot be clicked.
  await page.getByRole('button', { name: 'fit view' }).click();
  await page.waitForTimeout(600);

  // 2b. The System's box, close enough to read, with its drawer open so the card
  //     and the inspector show the same announcement side by side. The demo seeds
  //     two: the notice and the written-out level, and the level is the one whose
  //     drawer shows the fields its type asks for.
  const systemCard = node('[TIDAL LEDGER · GAIN]', 'system');
  await zoomOnCard(page, systemCard, READABLE_ZOOM, { x: 20, y: 20 });
  await page.waitForTimeout(400);
  // The card sits at the far left of the bottom tier, where the legend floats:
  // the board is nudged right and up so the whole box is on screen and clear of
  // the legend.
  await panBoard(page, 150, -120);
  await page.locator(`.react-flow__node[data-id="${systemCard}"]`).click();
  await page
    .waitForSelector('[aria-label="System box"]', { timeout: 5_000 })
    .catch(() => {
      fail(chat('the system card never opened its box in the drawer'));
    });
  await capture(page, 'system-box.png');

  await page.getByRole('button', { name: 'fit view' }).click();
  await page.waitForTimeout(500);

  // 3. A skill card's drawer, opened by clicking its card.
  await page.locator(`.react-flow__node[data-id="${node('Brine-Lung', 'skill')}"]`).click();
  await page.waitForSelector('#skill-holder-rank', { timeout: 5_000 }).catch(() => {
    fail(chat('the holder form never opened for the Brine-Lung card'));
  });
  await capture(page, 'card-inspector.png');

  // 4. The holder form filled in — typed, not submitted, because the picture is
  //    of the form the author is about to send.
  await page.selectOption('#skill-holder-character', { label: 'Tamsin Quill' });
  await page.selectOption('#skill-holder-chapter', { label: 'The Tally' });
  await page.fill('#skill-holder-rank', 'Rank 3');
  await capture(page, 'skill-holder-form.png');

  // 5. A drawn connection opened in its editor. The point to click is worked
  //    out rather than guessed: two of these lines run alongside each other
  //    between the same three cards, and either may lie under a card, so the
  //    script asks the page which point along the line the board would give to
  //    the line itself.
  // The line the clerk owes the wrecker by: it runs between two cards the board
  // leaves room around, so the script can reach the line itself.
  const line = edge('owes');
  const probe = await page.evaluate(id => {
    const group = document.querySelector(`[data-testid="rf__edge-${id}"]`);
    const path = group.querySelector('.react-flow__edge-interaction') ?? group.querySelector('path');
    const matrix = path.getScreenCTM();
    const total = path.getTotalLength();

    // Middle first, then outwards, so the editor opens near the line's label.
    const fractions = [];
    for (let step = 50; step >= 2; step -= 2) {
      fractions.push(step / 100, 1 - step / 100);
    }

    const seen = [];

    for (const fraction of fractions) {
      const along = path.getPointAtLength(total * fraction);
      const point = new DOMPoint(along.x, along.y).matrixTransform(matrix);
      const under = document.elementFromPoint(point.x, point.y);
      const hit = under && under.closest('[data-testid^="rf__edge-"]');

      if (hit && hit.getAttribute('data-testid') === `rf__edge-${id}`) {
        return { x: point.x, y: point.y };
      }

      if (seen.length < 4) {
        seen.push(`${Math.round(point.x)},${Math.round(point.y)} → ${under ? under.className || under.tagName : 'nothing'}`);
      }
    }

    return { blocked: seen };
  }, line);

  if ('x' in probe) {
    await page.mouse.click(probe.x, probe.y);
  } else {
    // On a board this full, a line can pass under cards for its whole length.
    // The click then goes to the line's own group, which is the element the
    // board listens on: same event, same editor, without a point to stand on.
    const reached = await page.evaluate(id => {
      const group = document.querySelector(`[data-testid="rf__edge-${id}"]`);
      if (!group) return false;

      group.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    }, line);

    if (!reached) {
      fail(
        chat(
          'no point along the connection is free of the cards lying over it: ' +
            probe.blocked.join(' | ')
        )
      );
    }
  }

  const opened = await page
    .locator('.node-editor .edge-endpoints')
    .textContent({ timeout: 5_000 })
    .catch(() => fail(chat('clicking the connection opened no editor')));

  if (!opened.includes('Tamsin Quill') || !opened.includes('Bram Ockley')) {
    fail(chat(`the connection editor opened on "${opened}" rather than Tamsin's line to Bram`));
  }

  await capture(page, 'connection-editor.png');

  // 6. Dragging from one character card's handle to another's, which is the
  //    gesture that writes a relation: the dialog is the app asking for its kind.
  const from = page.locator(
    `.react-flow__node[data-id="${node('Ivy Marrow', 'character')}"] .react-flow__handle-right`
  );
  const to = page.locator(
    `.react-flow__node[data-id="${node('Tamsin Quill', 'character')}"] .react-flow__handle-left`
  );

  await from.hover();
  await page.mouse.down();
  await to.hover();
  await page.mouse.up();

  await page
    .getByRole('heading', { name: 'Connect characters' })
    .waitFor({ timeout: 5_000 })
    .catch(() => fail(chat('dragging between two character cards opened no relation dialog')));
  await capture(page, 'relation-popover.png');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // 7. The chapter ledger, with the continuity advisories on it.
  // Exact, because the toolbar's “Chapters only” preset also answers to the
  // word a partial match would settle for.
  await page.getByRole('button', { name: 'Chapters', exact: true }).click();
  await page.waitForSelector('.chapter-totals', { timeout: 5_000 }).catch(() => {
    fail(chat('the Chapters tab never listed the reading order'));
  });
  await capture(page, 'chapters-tab.png');

  // 8. One character's sheet, then the same sheet scrolled to its lower half.
  await page.getByRole('button', { name: 'Characters' }).click();
  await page.locator('.character-item', { hasText: 'Ivy Marrow' }).click();
  await page.waitForSelector('.tab-content', { timeout: 5_000 });
  await capture(page, 'character-sheet.png');

  await page.evaluate(() => {
    const content = document.querySelector('.tab-content');
    if (content) content.scrollTop = 900;
  });
  await page.waitForTimeout(200);
  await capture(page, 'character-sheet-detail.png');

  // 9. The two other views of the same tab.
  await page.getByRole('button', { name: 'Relations', exact: true }).click();
  await page.waitForTimeout(300);
  await capture(page, 'relations-map.png');

  await page.getByRole('button', { name: 'Skill trees', exact: true }).click();
  await page.waitForTimeout(300);
  await capture(page, 'skill-tree.png');

  // 10. The three ledger tabs.
  await page.getByRole('button', { name: 'Quests' }).click();
  await page.waitForTimeout(300);
  await capture(page, 'quest-ledger.png');

  await page.getByRole('button', { name: 'Audit Log' }).click();
  await page.waitForTimeout(300);
  await capture(page, 'audit-log.png');

  await page.getByRole('button', { name: 'Trash' }).click();
  await page.waitForTimeout(300);
  await capture(page, 'trash-tab.png');

  // 11. The app's own guide, which is the author's document: the header's button
  //     opens STORYBOARDING.md itself, pictures included.
  await page.getByRole('button', { name: 'Guide' }).click();
  await page.getByRole('dialog', { name: 'Guide' }).waitFor({ timeout: 5_000 });

  // Scrolled to the guide's first section, which is short enough that its own
  // picture follows it on screen: the shot shows the document being read in the
  // app, one of its pictures among the words.
  await page.evaluate(() => {
    const body = document.querySelector('.guide-reader-body');
    const section = body && body.querySelector('[data-guide-anchor="1-get-a-story-open"]');

    if (body && section) {
      const offset =
        section.getBoundingClientRect().top - body.getBoundingClientRect().top;
      body.scrollTop += offset - 16;
    }
  });

  // And then waited for that picture to draw. The guide's pictures load as they
  // come into view, so the wait is for the one the shot is of — a picture of a
  // broken image would be a picture of a bug the run reports as fine.
  const guidePictureDrawn = await page
    .waitForFunction(
      () => {
        const picture = document.querySelector('.guide-reader-body img');
        return picture !== null && picture.complete && picture.naturalWidth > 0;
      },
      undefined,
      { timeout: 20_000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!guidePictureDrawn) fail(chat('the guide opened but its pictures never loaded'));

  await page.waitForTimeout(300);
  await capture(page, 'in-app-guide.png');

  // The dialog has both a “×” and a “Close”, and the first is named “Close
  // guide”, so the exact name is what picks the one in the footer.
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // 12. The board again, this time with the chapters' notes drawn on it. The
  //     connection editor opened at step 5 is put away first: the picture is of
  //     the notes, not of a line somebody was editing a hundred pictures ago.
  await page.getByRole('button', { name: 'Graph' }).click();

  const standingEditor = page.locator('.node-editor');

  if ((await standingEditor.count()) > 0) {
    await standingEditor.getByRole('button', { name: 'Close', exact: true }).click();
    await page
      .locator('.edge-endpoints')
      .waitFor({ state: 'detached', timeout: 5_000 })
      .catch(() => fail(chat('the connection editor would not close')));
  }

  await page.getByRole('button', { name: 'Show notes' }).click();
  await page.getByRole('button', { name: 'fit view' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'fit view' }).click();
  await page.waitForTimeout(600);
  // The note cards hang below their chapters, so the board is taller than the
  // frame again: one step back leaves the key its own corner.
  await page.getByRole('button', { name: 'zoom out' }).click();
  await page.waitForTimeout(500);
  await capture(page, 'canvas-notes.png');

  // 13. The search palette over the board: the query's matches listed by kind,
  //     the matching cards outlined behind it, and the filter row under the
  //     field. Two things are put back first: the line's editor, open on the
  //     board since step 5 (its own anchor was shot there), and the notes, so
  //     the picture is of the palette and the board it is searching.
  const openEdgeEditor = page.locator('.node-editor');

  if ((await openEdgeEditor.count()) > 0) {
    await openEdgeEditor.getByRole('button', { name: 'Close', exact: true }).click();
    await page
      .locator('.edge-endpoints')
      .waitFor({ state: 'detached', timeout: 5_000 })
      .catch(() => fail(chat('the connection editor would not close')));
  }

  await page.getByRole('button', { name: 'Hide notes' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Search' }).click();

  await page
    .getByRole('dialog', { name: 'Search the storyboard' })
    .waitFor({ timeout: 5_000 })
    .catch(() => fail(chat('the Search button opened no palette')));

  await page.fill('.canvas-search-input', 'bell');

  // A word the fixture is full of: cards, cast members and connections. Fewer
  // than five results would mean the picture was of a search that found almost
  // nothing, which is not the state this anchor is of.
  await page
    .waitForFunction(
      () => document.querySelectorAll('.canvas-search-result').length >= 5,
      undefined,
      { timeout: 5_000 }
    )
    .catch(() => fail(chat('the query matched fewer results than the story holds')));

  await capture(page, 'search-palette.png');
  await page.keyboard.press('Escape');
  await page
    .locator('.canvas-search')
    .waitFor({ state: 'detached', timeout: 5_000 })
    .catch(() => fail(chat('Escape did not close the search palette')));

  // 14. Creating a quest card: the form that writes the ledger row and the card
  //     together, filled in but not sent, because the picture is of what the
  //     author is about to create. Cancelling afterwards leaves nothing behind.
  await page.locator('.graph-toolbar select').selectOption('quest');
  await page.getByRole('button', { name: 'Add Node' }).click();

  const questForm = page.getByRole('dialog', { name: 'New quest' });
  await questForm.waitFor({ timeout: 5_000 }).catch(() => {
    fail(chat('choosing the quest type and pressing Add Node opened no form'));
  });

  await questForm.locator('input').first().fill('Bring the clapper back');

  const questFields = questForm.locator('select');
  await questFields.nth(0).selectOption({ label: 'Bram Ockley' });
  await questFields.nth(1).selectOption({ label: 'The Salt Choir' });
  await questFields.nth(2).selectOption({ label: 'After the Bell' });

  const questText = questForm.locator('textarea');
  await questText
    .nth(0)
    .fill('Return the clapper to the Choir before the next low tide opens the stair.');
  await questText.nth(1).fill('Ivy will not give it up; Bram would rather sell it twice.');

  await capture(page, 'quest-form.png');
  await questForm.getByRole('button', { name: 'Cancel' }).click();

  return story;
}

// ---- the gallery against the documents -----------------------------------

// The pictures this script shoots and the ones the documents show are two lists
// of the same files, kept by hand on one side and by the walk on the other.
// Ending every run by comparing them is what catches the drift in either
// direction.
//
// Every Markdown file at the top of the project is read, rather than a list of
// the two there are today, so a third guide is covered the day it is added.
async function galleryDrift(shot) {
  const documents = (await readdir(root)).filter(name => name.endsWith('.md'));
  const shown = new Map();

  for (const document of documents) {
    const text = await readFile(path.join(root, document), 'utf8');

    for (const match of text.matchAll(/screenshots\/([A-Za-z0-9._-]+\.png)/g)) {
      const shows = shown.get(match[1]) ?? [];
      shows.push(document);
      shown.set(match[1], shows);
    }
  }

  const onDisk = (await readdir(outDir)).filter(name => name.endsWith('.png'));
  const problems = [];

  for (const [name, where] of shown) {
    const who = where.length === 1 ? where[0] : `${where.slice(0, -1).join(', ')} and ${where.at(-1)}`;

    if (!shot.has(name)) problems.push(`${who} show ${name}, which this run did not shoot`);
  }

  for (const name of onDisk) {
    if (shot.has(name) && shown.has(name)) continue;

    problems.push(
      shot.has(name)
        ? `screenshots/${name} was shot but no document shows it`
        : `screenshots/${name} is in the gallery but nothing shot it`
    );
  }

  return problems;
}

// ---- the run -------------------------------------------------------------

async function main() {
  if (!argv.has('--no-fixture')) buildFixture();

  // `npm run fixture` stops here: the story is regenerated and the pictures are
  // left as they are.
  if (argv.has('--fixture-only')) return;

  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  await mkdir(outDir, { recursive: true });

  const server = await startServer();
  const browser = await launchBrowser();

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();

  // A picture of a screen with an error on it is not a picture of the app, so
  // anything the page complains about fails the run.
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));

  let failure = null;

  try {
    log('· walking the app');
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await shoot(page, fixture);

    log('· checking the gallery against the documents that show it');
    const drift = await galleryDrift(written);

    if (drift.length > 0) {
      log('\nthe guide and the gallery disagree about which pictures exist:');
      for (const problem of drift) log(`  ${problem}`);
    }

    if (errors.length > 0) {
      log('\nthe page logged problems while it was being photographed:');
      for (const error of errors) log(`  ${error}`);
      failure = `${errors.length} page error(s)`;
    }

    if (drift.length > 0) {
      failure = `${drift.length} image(s) drifting from the guide${
        failure ? `, and ${failure}` : ''
      }`;
    }
  } catch (error) {
    failure = error;
  } finally {
    await context.close();
    await browser.close();
    stopServer(server);
  }

  if (failure) {
    if (failure instanceof Error) throw failure;
    process.exitCode = 1;
    return;
  }

  log(`\n${written.size} images are in ${path.relative(root, outDir)}/`);
}

await main();
