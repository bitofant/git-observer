import type { Config } from "./config.js";
import {
  countPendingInsights,
  getSyncRow,
  lastSyncAt,
  listUnclassifiedPrs,
  setWatermark,
  upsertPullRequests,
  upsertReviewActivity,
} from "./db.js";
import {
  fetchPrDetail,
  fetchPrPage,
  fetchReviewComments,
  listOrgRepos,
} from "./github.js";
import { classifyPullRequest } from "./classify.js";

// The sync loop: walk each tracked repo's pull requests into SQLite, then
// classify whatever is still unclassified.
//
// Two properties matter more than speed here:
//  - It is INCREMENTAL. The GraphQL query is ordered UPDATED_AT DESC, so a
//    sync walks pages only until it reaches the repo's watermark and stops.
//    Without that, every sync re-walks all history and burns the rate limit.
//  - It DEGRADES PER REPO. One unreachable or renamed repo records its error
//    against its own watermark row and the others still sync; a throw here
//    would take the whole schedule down.

/** Pages are 50 PRs. This bounds a single repo's *first* sync so a decade-old
 * monorepo can't monopolize the loop — the next run picks up where it left. */
const MAX_PAGES_PER_REPO = 40;
/** PRs classified per sync. Classification costs two `gh` calls plus an LLM
 * round trip each, so a backfill is spread over several runs rather than
 * hammering both endpoints at once. */
const CLASSIFY_BATCH = 25;
/** Re-check a repo that failed no sooner than this, so a permanently broken
 * entry costs one call per interval instead of one per loop. */
const ERROR_BACKOFF_MS = 30 * 60_000;

let running = false;
let lastError: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export interface SyncState {
  running: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  pendingInsights: number;
}

export function syncState(): SyncState {
  return {
    running,
    lastSyncAt: lastSyncAt(),
    lastError,
    pendingInsights: countPendingInsights(),
  };
}

/** Every repo to track: the explicit list plus everything in the configured
 * orgs, deduped. Org expansion is best-effort — a failure leaves the explicit
 * repos syncing rather than emptying the list. */
export async function resolveRepos(config: Config): Promise<string[]> {
  const { command, repos = [], orgs = [] } = config.github;
  const all = new Set(repos.map((r) => r.trim()).filter(Boolean));
  for (const org of orgs) {
    for (const repo of await listOrgRepos(command, org)) all.add(repo);
  }
  return [...all];
}

/** A repo whose last attempt errored is retried no sooner than the backoff, so
 * a renamed/deleted/permission-denied entry costs one call per half hour rather
 * than one per loop. `attemptedAt` is when we last touched it, error or not. */
export function shouldSkipRepo(
  row: { lastSyncedAt: number; lastError: string | null } | null,
  now: number,
  backoffMs = ERROR_BACKOFF_MS,
): boolean {
  if (!row?.lastError) return false;
  return now - row.lastSyncedAt < backoffMs;
}

async function syncRepo(
  config: Config,
  repo: string,
  now: number,
): Promise<void> {
  const row = getSyncRow(repo);
  // A previously-failed repo has no trustworthy watermark: its last run may
  // have stopped anywhere, so fall back to the backfill floor rather than
  // resuming from a point nothing was actually ingested up to.
  const watermark = row && !row.lastError ? row.lastSyncedAt : null;
  // First sync reaches back `backfillDays`; later ones stop at the watermark.
  const floor =
    watermark ?? now - (config.github.backfillDays ?? 90) * 86_400_000;

  // Stamp the attempt time, not the (unreached) watermark — that's what the
  // backoff measures from.
  const fail = (error: string) => {
    setWatermark(repo, now, error);
    lastError = `${repo}: ${error}`;
  };

  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES_PER_REPO; page++) {
    const result = await fetchPrPage(config.github.command, repo, cursor);
    if ("error" in result) return fail(result.error);
    if (result.prs.length > 0) upsertPullRequests(result.prs);
    if (result.reviews.length > 0) {
      upsertReviewActivity(result.reviews);
      // Failing the repo (not skipping) matters: advancing the watermark past
      // these PRs would lose their inline comments for good.
      const inline = await fetchReviewComments(config.github.command, result.reviews);
      if ("error" in inline) return fail(inline.error);
      if (inline.length > 0) upsertReviewActivity(inline);
    }

    // Ordered UPDATED_AT DESC: once a page's oldest entry predates the floor,
    // everything after it does too.
    const exhausted =
      !result.hasNextPage ||
      (result.oldestUpdatedAt !== null && result.oldestUpdatedAt < floor);
    if (exhausted) break;
    cursor = result.endCursor;
    if (!cursor) break;
  }

  // Re-sync from slightly before now: a PR updated during the sync would
  // otherwise fall in the gap between this watermark and the next run.
  setWatermark(repo, now - 60_000);
}

/** Classify a bounded batch of unclassified PRs. No-op without an LLM
 * endpoint — `classifyPullRequest` checks that itself and returns false. */
async function classifyBatch(config: Config): Promise<void> {
  for (const pr of listUnclassifiedPrs(CLASSIFY_BATCH)) {
    const detail = await fetchPrDetail(config.github.command, pr.repo, pr.number);
    if (!detail) continue;
    await classifyPullRequest(pr, detail.body, detail.files);
  }
}

/** One full pass. Single-flight: a slow sync must never overlap the next tick,
 * or two passes fight over the same rate limit and watermarks. */
export async function runSync(config: Config): Promise<void> {
  if (running) return;
  running = true;
  lastError = null;
  const now = Date.now();
  try {
    for (const repo of await resolveRepos(config)) {
      if (shouldSkipRepo(getSyncRow(repo), now)) continue;
      await syncRepo(config, repo, now);
    }
    await classifyBatch(config);
  } catch (err) {
    lastError = (err as Error).message;
  } finally {
    running = false;
  }
}

export function startSyncSchedule(config: Config): void {
  const minutes = config.sync?.intervalMinutes ?? 30;
  if (timer) clearInterval(timer);
  void runSync(config);
  timer = setInterval(() => void runSync(config), minutes * 60_000);
  timer.unref?.(); // the schedule must not be what keeps the process alive
}

export { ERROR_BACKOFF_MS };
