import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Testing Library only registers its own cleanup when Vitest globals are on;
// this suite imports from 'vitest' explicitly, so unmount between tests here.
afterEach(() => {
  cleanup();
});
