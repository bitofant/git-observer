// One-shot sync from the command line: `npm run sync`.
// Useful for the first backfill (which can take a while) and for debugging an
// ingest problem without the server running.

import { loadConfig } from "../server/config.js";
import { startLlmPolling } from "../server/llm.js";
import { runSync, resolveRepos, syncState } from "../server/ingest.js";
import { githubStatus } from "../server/github.js";
import { closeDb } from "../server/db.js";

const config = loadConfig();

const gh = await githubStatus(config.github.command);
if (!gh.available) {
  console.error(`github unavailable: ${gh.detail}`);
  process.exit(1);
}

startLlmPolling(config.llm);
// Give the health poll a moment; without it the first run classifies nothing.
await new Promise((r) => setTimeout(r, 1500));

const repos = await resolveRepos(config);
console.log(`syncing ${repos.length} repo(s): ${repos.join(", ") || "(none)"}`);

await runSync(config);

const state = syncState();
console.log(
  `done. pending insights: ${state.pendingInsights}` +
    (state.lastError ? `, last error: ${state.lastError}` : ""),
);
closeDb();
