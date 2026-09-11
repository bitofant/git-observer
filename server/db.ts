import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type {
  Person,
  PrInsight,
  PrSize,
  PullRequest,
  ReviewActivity,
} from "../shared/protocol.js";

// The project's only persistence layer: tracked people, the ingested GitHub
// rows, their LLM insights, and the per-repo sync watermarks. Everything here
// is a *cache of GitHub* except the `people` table, which is the only real
// user-authored state — so the DB can be deleted and re-synced at the cost of
// re-classifying (which is why insights are keyed by content hash, not by time).

const DB_PATH = resolve(process.cwd(), "data/git-observer.db");

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(
  `CREATE TABLE IF NOT EXISTS people (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     login TEXT NOT NULL UNIQUE COLLATE NOCASE,
     display_name TEXT NOT NULL,
     added_at INTEGER NOT NULL
   )`,
);

// Ingested pull requests. Keyed by (repo, number) — GitHub's own identity —
// so a re-sync upserts rather than duplicating.
db.exec(
  `CREATE TABLE IF NOT EXISTS pull_requests (
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     title TEXT NOT NULL,
     author TEXT NOT NULL COLLATE NOCASE,
     state TEXT NOT NULL,
     url TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     merged_at INTEGER,
     closed_at INTEGER,
     additions INTEGER NOT NULL DEFAULT 0,
     deletions INTEGER NOT NULL DEFAULT 0,
     changed_files INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (repo, number)
   )`,
);
db.exec("CREATE INDEX IF NOT EXISTS pr_author ON pull_requests(author)");
db.exec("CREATE INDEX IF NOT EXISTS pr_merged_at ON pull_requests(merged_at)");
db.exec("CREATE INDEX IF NOT EXISTS pr_created_at ON pull_requests(created_at)");

// The LLM's read of a PR. `input_hash` is what a re-classification is keyed on:
// a PR whose title/body/diffstat changed is stale and gets re-judged, while an
// untouched one is never paid for twice.
db.exec(
  `CREATE TABLE IF NOT EXISTS pr_insights (
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     size TEXT NOT NULL,
     summary TEXT NOT NULL,
     model TEXT NOT NULL,
     input_hash TEXT NOT NULL,
     classified_at INTEGER NOT NULL,
     PRIMARY KEY (repo, number)
   )`,
);

// Reviews and comments. `pr_author` is denormalized on purpose: every query
// that matters asks "activity on someone ELSE's PR", and carrying the author
// here turns that filter into a column compare instead of a join.
db.exec(
  `CREATE TABLE IF NOT EXISTS review_activity (
     id TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     pr_number INTEGER NOT NULL,
     pr_author TEXT NOT NULL COLLATE NOCASE,
     actor TEXT NOT NULL COLLATE NOCASE,
     kind TEXT NOT NULL,
     state TEXT,
     submitted_at INTEGER NOT NULL,
     url TEXT NOT NULL
   )`,
);
db.exec("CREATE INDEX IF NOT EXISTS ra_actor ON review_activity(actor)");
db.exec(
  "CREATE INDEX IF NOT EXISTS ra_submitted_at ON review_activity(submitted_at)",
);

// Per-repo incremental sync watermark. Without this every sync re-walks all
// history and burns the GitHub rate limit for nothing.
db.exec(
  `CREATE TABLE IF NOT EXISTS sync_state (
     repo TEXT PRIMARY KEY,
     last_synced_at INTEGER NOT NULL,
     last_error TEXT
   )`,
);

// --- people ----------------------------------------------------------------

const rowToPerson = (r: {
  id: number;
  login: string;
  display_name: string;
  added_at: number;
}): Person => ({
  id: r.id,
  login: r.login,
  displayName: r.display_name,
  addedAt: r.added_at,
});

export function listPeople(): Person[] {
  return db
    .prepare("SELECT * FROM people ORDER BY display_name COLLATE NOCASE")
    .all()
    .map((r) => rowToPerson(r as never));
}

export function getPerson(login: string): Person | null {
  const row = db.prepare("SELECT * FROM people WHERE login = ?").get(login);
  return row ? rowToPerson(row as never) : null;
}

/** Add a tracked person. Idempotent on login (case-insensitive) so re-adding
 * someone updates their display name instead of erroring. */
export function addPerson(login: string, displayName: string): Person {
  db.prepare(
    `INSERT INTO people (login, display_name, added_at) VALUES (?, ?, ?)
     ON CONFLICT(login) DO UPDATE SET display_name = excluded.display_name`,
  ).run(login, displayName || login, Date.now());
  return getPerson(login)!;
}

/** Remove a person. Ingested rows are deliberately left alone — they're a cache
 * of GitHub keyed by login, shared with every other person's review counts, and
 * re-adding someone should not need a re-sync. */
export function removePerson(login: string): void {
  db.prepare("DELETE FROM people WHERE login = ?").run(login);
}

// --- pull requests ---------------------------------------------------------

const rowToPr = (r: Record<string, never>): PullRequest => ({
  repo: r.repo as never as string,
  number: r.number as never as number,
  title: r.title as never as string,
  author: r.author as never as string,
  state: r.state as never as PullRequest["state"],
  url: r.url as never as string,
  createdAt: r.created_at as never as number,
  mergedAt: (r.merged_at as never as number) ?? null,
  closedAt: (r.closed_at as never as number) ?? null,
  additions: r.additions as never as number,
  deletions: r.deletions as never as number,
  changedFiles: r.changed_files as never as number,
});

const upsertPrStmt = db.prepare(
  `INSERT INTO pull_requests
     (repo, number, title, author, state, url, created_at, merged_at,
      closed_at, additions, deletions, changed_files)
   VALUES (@repo, @number, @title, @author, @state, @url, @createdAt,
           @mergedAt, @closedAt, @additions, @deletions, @changedFiles)
   ON CONFLICT(repo, number) DO UPDATE SET
     title = excluded.title, state = excluded.state,
     merged_at = excluded.merged_at, closed_at = excluded.closed_at,
     additions = excluded.additions, deletions = excluded.deletions,
     changed_files = excluded.changed_files`,
);

export const upsertPullRequests = db.transaction((prs: PullRequest[]) => {
  for (const pr of prs) upsertPrStmt.run(pr as never);
});

export function pullRequestsInRange(
  logins: string[],
  start: number,
  end: number,
): PullRequest[] {
  if (logins.length === 0) return [];
  const marks = logins.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM pull_requests
       WHERE author IN (${marks})
         AND ((created_at >= ? AND created_at < ?)
           OR (merged_at >= ? AND merged_at < ?))`,
    )
    .all(...logins, start, end, start, end)
    .map((r) => rowToPr(r as never));
}

/** Every PR by these authors, for building the week picker. */
export function pullRequestTimestamps(logins: string[]): number[] {
  if (logins.length === 0) return [];
  const marks = logins.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT created_at, merged_at FROM pull_requests WHERE author IN (${marks})`,
    )
    .all(...logins)
    .flatMap((r) => {
      const row = r as { created_at: number; merged_at: number | null };
      return row.merged_at ? [row.created_at, row.merged_at] : [row.created_at];
    });
}

// --- insights --------------------------------------------------------------

export function insightsFor(
  refs: { repo: string; number: number }[],
): Map<string, PrInsight> {
  const out = new Map<string, PrInsight>();
  if (refs.length === 0) return out;
  const stmt = db.prepare(
    "SELECT * FROM pr_insights WHERE repo = ? AND number = ?",
  );
  for (const ref of refs) {
    const row = stmt.get(ref.repo, ref.number) as
      | {
          repo: string;
          number: number;
          size: PrSize;
          summary: string;
          model: string;
          classified_at: number;
        }
      | undefined;
    if (!row) continue;
    out.set(`${row.repo}#${row.number}`, {
      repo: row.repo,
      number: row.number,
      size: row.size,
      summary: row.summary,
      model: row.model,
      classifiedAt: row.classified_at,
    });
  }
  return out;
}

export function saveInsight(
  insight: PrInsight & { inputHash: string },
): void {
  db.prepare(
    `INSERT INTO pr_insights
       (repo, number, size, summary, model, input_hash, classified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, number) DO UPDATE SET
       size = excluded.size, summary = excluded.summary,
       model = excluded.model, input_hash = excluded.input_hash,
       classified_at = excluded.classified_at`,
  ).run(
    insight.repo,
    insight.number,
    insight.size,
    insight.summary,
    insight.model,
    insight.inputHash,
    insight.classifiedAt,
  );
}

/** True when this PR has never been classified, or was classified from
 * different content (title/body/diffstat changed since). */
export function insightIsStale(
  repo: string,
  number: number,
  inputHash: string,
): boolean {
  const row = db
    .prepare("SELECT input_hash FROM pr_insights WHERE repo = ? AND number = ?")
    .get(repo, number) as { input_hash: string } | undefined;
  return !row || row.input_hash !== inputHash;
}

/** PRs with no insight yet, newest first — recent work is what a weekly view
 * shows, so classify that before backfilling history. */
export function listUnclassifiedPrs(limit: number): PullRequest[] {
  return db
    .prepare(
      `SELECT p.* FROM pull_requests p
       LEFT JOIN pr_insights i ON i.repo = p.repo AND i.number = p.number
       WHERE i.repo IS NULL
       ORDER BY COALESCE(p.merged_at, p.created_at) DESC
       LIMIT ?`,
    )
    .all(limit)
    .map((r) => rowToPr(r as never));
}

export function countPendingInsights(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pull_requests p
       LEFT JOIN pr_insights i ON i.repo = p.repo AND i.number = p.number
       WHERE i.repo IS NULL`,
    )
    .get() as { n: number };
  return row.n;
}

// --- review activity -------------------------------------------------------

const upsertReviewStmt = db.prepare(
  `INSERT INTO review_activity
     (id, repo, pr_number, pr_author, actor, kind, state, submitted_at, url)
   VALUES (@id, @repo, @prNumber, @prAuthor, @actor, @kind, @state,
           @submittedAt, @url)
   ON CONFLICT(id) DO UPDATE SET
     state = excluded.state, pr_author = excluded.pr_author`,
);

export const upsertReviewActivity = db.transaction(
  (rows: (ReviewActivity & { id: string })[]) => {
    for (const row of rows) upsertReviewStmt.run(row as never);
  },
);

export function reviewActivityInRange(
  logins: string[],
  start: number,
  end: number,
): ReviewActivity[] {
  if (logins.length === 0) return [];
  const marks = logins.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM review_activity
       WHERE actor IN (${marks}) AND submitted_at >= ? AND submitted_at < ?`,
    )
    .all(...logins, start, end)
    .map((r) => {
      const row = r as {
        repo: string;
        pr_number: number;
        pr_author: string;
        actor: string;
        kind: ReviewActivity["kind"];
        state: ReviewActivity["state"];
        submitted_at: number;
        url: string;
      };
      return {
        repo: row.repo,
        prNumber: row.pr_number,
        prAuthor: row.pr_author,
        actor: row.actor,
        kind: row.kind,
        state: row.state,
        submittedAt: row.submitted_at,
        url: row.url,
      };
    });
}

export function reviewTimestamps(logins: string[]): number[] {
  if (logins.length === 0) return [];
  const marks = logins.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT submitted_at FROM review_activity WHERE actor IN (${marks})`,
    )
    .all(...logins)
    .map((r) => (r as { submitted_at: number }).submitted_at);
}

// --- sync state ------------------------------------------------------------

export interface SyncRow {
  lastSyncedAt: number;
  lastError: string | null;
}

export function getSyncRow(repo: string): SyncRow | null {
  const row = db
    .prepare("SELECT last_synced_at, last_error FROM sync_state WHERE repo = ?")
    .get(repo) as { last_synced_at: number; last_error: string | null } | undefined;
  return row
    ? { lastSyncedAt: row.last_synced_at, lastError: row.last_error }
    : null;
}

export function getWatermark(repo: string): number | null {
  return getSyncRow(repo)?.lastSyncedAt ?? null;
}

export function setWatermark(repo: string, at: number, error?: string): void {
  db.prepare(
    `INSERT INTO sync_state (repo, last_synced_at, last_error) VALUES (?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET
       last_synced_at = excluded.last_synced_at,
       last_error = excluded.last_error`,
  ).run(repo, at, error ?? null);
}

export function lastSyncAt(): number | null {
  const row = db
    .prepare("SELECT MAX(last_synced_at) AS at FROM sync_state")
    .get() as { at: number | null };
  return row.at;
}

export function closeDb(): void {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  } catch {
    // Shutdown path — a failed checkpoint must never block exit.
  }
}
