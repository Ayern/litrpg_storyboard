# Screenshot harness

The images in [`GUIDE.md`](../../GUIDE.md) are photographs of the real app. There
is no second UI to keep in step: this folder renders `src/App.tsx` in a browser
page and answers its Tauri commands from a small in-memory backend, so whatever
the guide shows is what the app draws.

```
tools/screenshots/
├── fixture.json      the sample story, written by the Rust example (generated)
├── capture.mjs       the one step: rebuild the story, then re-shoot every picture
├── backend.ts        the fake backend: reads from fixture.json, writes in memory
├── mock/             the four Tauri modules the app imports, replaced by aliases
├── index.html        the page
├── main.tsx          renders src/App.tsx with src/styles.css
└── vite.config.ts    root, port 5199 and the module aliases
```

Nothing here is part of the app. `npm run build`, `npm test` and the Tauri
bundles do not read this folder; `tsconfig.json` includes only `src/`.

## Refreshing the gallery in one step

```bash
npm run screenshots
```

That is the whole refresh, and the only command the gallery needs: it regenerates
`fixture.json` with the Rust example below, then walks the app in a real browser
and re-shoots the eighteen pictures `GUIDE.md` shows. `npm run screenshots --
--no-fixture` shoots from the fixture already on disk, and `npm run fixture`
regenerates the story and leaves the pictures alone.

The run fails rather than photographing the wrong screen. Each anchor is waited
for and checked — the connection editor, the relation dialog, the holder form — so
a state the script cannot reach stops the walk instead of quietly writing a
picture of somewhere else. It then reads every Markdown document at the top of the project,
collects the images they link and compares them with the ones it just shot, failing
on either kind of drift: a picture a document shows that this run did not shoot, or
one sitting in `screenshots/` that no page shows.

A browser is not downloaded: `playwright-core` drives an installed Chrome, Edge
or Chromium. Set `SCREENSHOTS_BROWSER` to an executable path to name one
outright, and `SCREENSHOTS_PORT` (default 5188, so that the harness server below,
on 5199, can stay up beside it) if something else is on that port.

## The sample story

`fixture.json` is produced by the database crate's own example, not by hand — it is
the first half of `npm run screenshots`, and can also be run on its own so every
row has the shape the desktop build would send:

```bash
cd src-tauri
cargo run -p litrpg-db --example screenshot_fixture -- ../tools/screenshots/fixture.json
```

That example seeds the prepared demo story (`create_demo_story`) and then adds
the cards, bonds, quests, loot and trash the guide needs to show. The app's own
demo story is the base — the 100 XP gap in Mira's ledger that the continuity
panel finds is the one the demo ships with — and everything on top of it is
written through the ordinary public methods.

## Running it

```bash
npx vite --config tools/screenshots/vite.config.ts
```

Then open <http://localhost:5199/>. The story is already loaded; the story shelf,
the tabs, the canvas, the drawers and the dialogs all work, because only the
command channel is replaced. Writes change the in-memory copy and the UI reacts
exactly as it does in the app. A command the backend does not implement logs
`[harness] <name> is not implemented; the UI got null` in the console instead of
failing silently.

Two things are deliberately absent:

- **Import and export** answer as if the file picker were cancelled, since there
  is no filesystem behind the page.
- **Undo and redo** walk the recorded steps and re-issue the same writes, but the
  writes are served from memory, so a step is only as durable as the reload.

## Adding an anchor to the guide

The galleries are one list in two places: the walk in `capture.mjs` shoots a
picture for every anchor the guide shows, and the table at the end of `GUIDE.md`
names the file each one became. A picture that only one of them knows about is
the drift the run refuses, so a new section of the guide comes with a step in
`capture.mjs` and a row in that table.

A one-off picture is a plain browser page away: start the harness as above
(`npx vite --config tools/screenshots/vite.config.ts`), set a window of
1600×1000, dismiss the welcome card, and capture whatever state you are looking
at. If it is a state the guide should keep showing, it belongs in `capture.mjs` —
otherwise the next full run reports the file as gallery drift.
