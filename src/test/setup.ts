import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { configure, cleanup } from '@testing-library/react';

// A wait that is instant on a developer machine can still be queued behind a
// render on the CI runner, where every file runs at once. The budget is raised
// rather than the assertions relaxed: an element that never appears still fails,
// and the per-test timeout in vite.config.ts stays the thing that catches a hang.
configure({ asyncUtilTimeout: 5_000 });

// Testing Library only registers its own cleanup when Vitest globals are on;
// this suite imports from 'vitest' explicitly, so unmount between tests here.
afterEach(() => {
  cleanup();
});
