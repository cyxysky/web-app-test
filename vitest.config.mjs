import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Local capability packages are consumed from their TypeScript workspace
    // sources; published packages continue to resolve through package exports.
    tsconfigPaths: true,
  },
});
