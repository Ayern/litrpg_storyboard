import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The screenshot harness: the real app, served from a browser page, with the
// Tauri commands answered by an in-memory backend built from `fixture.json`.
//
//   npx vite --config tools/screenshots/vite.config.ts
//
// It is not part of `npm run build` and nothing in `src/` imports anything from
// here: the aliases below point the app's Tauri imports at the mock modules for
// this server only.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('.'),
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@tauri-apps/api/core', replacement: here('./mock/core.ts') },
      { find: '@tauri-apps/api/window', replacement: here('./mock/window.ts') },
      { find: '@tauri-apps/plugin-dialog', replacement: here('./mock/dialog.ts') },
      {
        find: '@tauri-apps/plugin-clipboard-manager',
        replacement: here('./mock/clipboard.ts'),
      },
    ],
  },
  server: { port: 5199, strictPort: true },
});
