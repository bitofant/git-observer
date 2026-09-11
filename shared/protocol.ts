// The REST contract, shared by both sides. Everything the browser knows about
// a person's activity is one of these shapes.

/** A tracked developer. `login` is the GitHub login and the join key for every
 * ingested row — display name is cosmetic and may be edited freely. */
export interface Person {
  id: number;
  login: string;
  displayName: string;
  addedAt: number;
}

/** ISO-8601 week id, e.g. "2026-W37". Weeks run Mon–Sun in UTC — see
 * shared/week.ts for why the whole app agrees on one bucketing rule. */
export type WeekId = string;

/** How much thought a PR represents. Deliberately NOT a diff-size bucket: a
 * 900-line lockfile bump is trivial and a 15-line auth change is large, so
 * this is judged by the LLM from title/body/files/diffstat (server/classify.ts). */
export type PrSize = "trivial" | "small" | "medium" | "large";

export const PR_SIZES: PrSize[] = ["trivial", "small", "medium", "large"];

export type PrState = "open" | "merged" | "closed";

/** One ingested pull request. Mirrors the `pull_requests` table. */
export interface PullRequest {
  repo: string; // owner/name
  number: number;
  title: string;
  author: string; // GitHub login
  state: PrState;
  url: string;
  createdAt: number;
  /** Null while open. The moment a PR *lands* is what weekly rollups bucket on. */
  mergedAt: number | null;
  closedAt: number | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** The LLM's read of a PR. Absent (not faked) when no endpoint was reachable. */
export interface PrInsight {
  repo: string;
  number: number;
  size: PrSize;
  /** One sentence, high level — what the PR does, not how. */
  summary: string;
  model: string;
  classifiedAt: number;
}

/** A PR joined with its insight, which is what every view actually wants. */
export interface PrWithInsight extends PullRequest {
  insight: PrInsight | null;
}

/** Review activity *on someone else's* PR — the "is this person engaged in
 * review?" signal. `kind` separates a formal review verdict, a conversation
 * comment, and an inline comment on a code line, because they mean different
 * things. */
export interface ReviewActivity {
  repo: string;
  prNumber: number;
  prAuthor: string;
  actor: string;
  kind: "review" | "comment" | "inline";
  /** Only set for kind "review". */
  state: "approved" | "changes_requested" | "commented" | null;
  submittedAt: number;
  url: string;
}

/** Everything the dashboard shows for one person in one week. Derived on read
 * (never stored) — see CLAUDE.md "Weeks are derived, never stored". */
export interface WeeklyReport {
  login: string;
  week: WeekId;
  /** Inclusive UTC bounds of the week, for display. */
  start: number;
  end: number;
  authored: {
    opened: PrWithInsight[];
    merged: PrWithInsight[];
    /** Counts by size across `merged`; unclassified PRs land in `unknown`. */
    sizes: Record<PrSize | "unknown", number>;
    additions: number;
    deletions: number;
  };
  reviewing: {
    /** Reviews/comments this person left on OTHER people's PRs. */
    reviews: number;
    /** Conversation comments on the PR itself. */
    comments: number;
    /** Comments on specific code lines — the most common review style. */
    inlineComments: number;
    /** Distinct PRs touched, so 30 comments on one PR isn't 30 PRs of review. */
    prsTouched: number;
    /** Distinct PR authors helped — breadth of review, not just volume. */
    authorsHelped: number;
  };
}

/** A week with just enough detail to render the week picker without loading
 * every report. */
export interface WeekSummary {
  week: WeekId;
  merged: number;
  opened: number;
  reviews: number;
}

/** Health of the two external dependencies. Both are optional at runtime and
 * degrade independently: no `gh` means no data, no LLM means no insights. */
export interface Status {
  github: {
    available: boolean;
    /** Populated when `gh` is present but unusable (unauthenticated, etc.). */
    detail: string | null;
    repos: string[];
  };
  llm: {
    available: boolean;
    model: string | null;
  };
  sync: {
    running: boolean;
    lastSyncAt: number | null;
    lastError: string | null;
    /** PRs awaiting classification. Non-zero is normal right after a backfill. */
    pendingInsights: number;
  };
}
