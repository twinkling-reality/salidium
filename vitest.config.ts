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
      // Published for the same reason and resolved to source the same way.
      '@salidium/consumer-contract': fileURLToPath(
        new URL('./packages/consumer-contract/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/**/src/**/*.test.ts', 'packages/**/src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // Provider isolation: see `packages/adapter-kit/src/testing/providerIsolation.ts`.
    setupFiles: ['./vitest.setup.ts'],
    passWithNoTests: false,
    /*
     * Above the budget the suite's own helpers already take, rather than below it.
     *
     * Several tests here spawn a real Node process running this CLI from TypeScript source, and
     * some of those spawn a second one. `daemonLaunch.test.ts` gives each `run` a 9 s ceiling and
     * the daemon's ready loop polls a hundred times at 100 ms, so a single legitimate case can
     * reach ten seconds before anything is wrong. The default of five is under both, which meant
     * the suite was not asserting a budget, it was racing one: a full run failed two to four tests
     * while every one of them passed alone, the file blamed moved between runs, and the same thing
     * happened on CI, where a green `check` and a red one landed on identical commits. That is the
     * shape of a timeout set too low, not of a defect, and it makes the suite something people
     * learn to re-run rather than read.
     *
     * Twenty is still a bound. A test that genuinely hangs fails here, fifteen seconds later than
     * it used to.
     */
    testTimeout: 20_000,
  },
});
