import { defineConfig } from "vitest/config";

// Live end-to-end tests: `*.e2e.test.ts` spawn the real `gh` CLI and/or call
// the configured LLM endpoint. Kept out of the default `npm test` gate because
// they need an authenticated `gh` and a running endpoint; the tests self-skip
// when either is unavailable. Run: `npm run test:e2e`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One LLM endpoint and one GitHub rate-limit budget — run files
    // sequentially so concurrent requests don't starve each other.
    fileParallelism: false,
  },
});
