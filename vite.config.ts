import { defineConfig } from "vitest/config";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({

  plugins: [react()],

  // The board is the first screen, so React and React Flow are needed before
  // anything is drawn and none of this is deferred. What the split buys is file
  // size: the two libraries and the app's own code are downloaded in parallel
  // off the local disk instead of as one 750 kB script, so none of the three is
  // near the bundler's warning size and a change to the app does not mint a new
  // URL for React.
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: 'reactflow',
              test: /node_modules[\\/](@reactflow|reactflow|d3-[^\\/]+|zustand|classcat)[\\/]/,
            },
          ],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // These tests drive the whole app: a render, a tab switch and several
    // typed edits each. The 5s default is comfortable on a developer's machine
    // but the inventory undo/redo tests crossed it on the CI runner, so the
    // budget is set where a genuinely hung test still fails quickly.
    testTimeout: 20_000,
  },
}));
