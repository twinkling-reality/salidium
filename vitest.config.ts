import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['development'],
    alias: {
      /*
       * `@salidium/sync-contract` is the only published workspace package, so its export map has to
       * describe the tarball and nothing else. It therefore cannot carry a `development` condition
       * pointing at `src/`, which npm does not ship. The alias keeps tests running against source
       * without a prior build, where the other packages get that from their own `development`
       * condition.
       */
      '@salidium/sync-contract': fileURLToPath(
        new URL('./packages/sync-contract/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/**/src/**/*.test.ts', 'packages/**/src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    passWithNoTests: false,
  },
});
