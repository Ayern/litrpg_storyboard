# Screenshot harness

The images in [`GUIDE.md`](../../GUIDE.md) are photographs of the real app. There
is no second UI to keep in step: this folder renders `src/App.tsx` in a browser
page and answers its Tauri commands from a small in-memory backend, so whatever
the guide shows is what the app draws.

```
tools/screenshots/
├── fixture.json      the sample story, written by the Rust example (generated)
├── backend.ts        the fake backend: reads from fixture.json, writes in memory
├── mock/             the four Tauri modules the app imports, replaced by aliases
├── index.html        the page
├── main.tsx          renders src/App.tsx with src/styles.css
└── vite.config.ts    root, port 5199 and the module aliases
```

Nothing here is part of the app. `npm run build`, `npm test` and the Tauri
bundles do not read this folder; `tsconfig.json` includes only `src/`.

## Regenerating the sample story

`fixture.json` is produced by the database crate's own example, not by hand, so
every row has the shape the desktop build would send:

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

## Taking a screenshot

The page is a plain browser page, so the app's own layout is the only styling:
set a window of 1600×1000, dismiss the welcome card, and capture the state you
want. The anchors the guide uses, and the file each one became, are listed at the
end of `GUIDE.md`.
