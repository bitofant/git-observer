import { defineConfig, configDefaults } from "vitest/config";

// Boring by design: plain Node environment, co-located `*.test.ts` files.
// The gate covers only pure functions — week bucketing, `gh` output parsers,
// rollup aggregation, LLM output sanitizers — so it runs in milliseconds with
// no network, no subprocesses, no tokens.
//
// `*.e2e.test.ts` (live `gh` / live LLM endpoint) are excluded here so this
// gate stays pure/fast; run them with `npm run test:e2e` (vitest.e2e.config.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
  },
});
