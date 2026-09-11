import type {
  PrInsight,
  PrSize,
  PrWithInsight,
  PullRequest,
  ReviewActivity,
  WeeklyReport,
  WeekId,
  WeekSummary,
} from "../shared/protocol.js";
import { weekBounds, weekIdOf } from "../shared/week.js";

// Weekly aggregation. PURE — it takes rows and returns the report, so every
// number on the dashboard is testable without a database.
//
// Weeks are DERIVED, never stored. A materialized rollup table would be wrong
// here rather than merely redundant: a PR merged late, a re-classification
// after a title edit, or a person added months after the fact all retroactively
// change a past week, and a cached row has no way to know. SQLite grouping over
// a few thousand rows is far cheaper than the staleness bugs.

const key = (repo: string, number: number) => `${repo}#${number}`;

/** GitHub logins are case-insensitive; two spellings of one person must never
 * split a week's counts in half. */
const sameLogin = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

export function withInsights(
  prs: PullRequest[],
  insights: Map<string, PrInsight>,
): PrWithInsight[] {
  return prs.map((pr) => ({
    ...pr,
    insight: insights.get(key(pr.repo, pr.number)) ?? null,
  }));
}

function emptySizes(): Record<PrSize | "unknown", number> {
  return { trivial: 0, small: 0, medium: 0, large: 0, unknown: 0 };
}

/** Newest activity first — a weekly view is read top-down. */
const byRecency = (a: PrWithInsight, b: PrWithInsight) =>
  (b.mergedAt ?? b.createdAt) - (a.mergedAt ?? a.createdAt);

export function buildWeeklyReport(
  login: string,
  week: WeekId,
  prs: PullRequest[],
  reviews: ReviewActivity[],
  insights: Map<string, PrInsight>,
): WeeklyReport {
  const { start, end } = weekBounds(week);
  const inWeek = (t: number | null): t is number =>
    t !== null && t >= start && t < end;

  const mine = withInsights(
    prs.filter((p) => sameLogin(p.author, login)),
    insights,
  );

  const opened = mine.filter((p) => inWeek(p.createdAt)).sort(byRecency);
  const merged = mine.filter((p) => inWeek(p.mergedAt)).sort(byRecency);

  // Size counts run over MERGED PRs, not opened ones: a PR opened in one week
  // and merged three weeks later belongs to the week it landed, and counting it
  // in both would double every total.
  const sizes = emptySizes();
  let additions = 0;
  let deletions = 0;
  for (const pr of merged) {
    sizes[pr.insight?.size ?? "unknown"] += 1;
    additions += pr.additions;
    deletions += pr.deletions;
  }

  // Review activity means work done on OTHER people's PRs. Self-comments are a
  // developer replying on their own PR — real, but not review of others, and
  // counting them makes a chatty author look like an engaged reviewer.
  const theirs = reviews.filter(
    (r) =>
      sameLogin(r.actor, login) &&
      !sameLogin(r.prAuthor, login) &&
      inWeek(r.submittedAt),
  );

  return {
    login,
    week,
    start,
    end,
    authored: { opened, merged, sizes, additions, deletions },
    reviewing: {
      reviews: theirs.filter((r) => r.kind === "review").length,
      comments: theirs.filter((r) => r.kind === "comment").length,
      // Distinct PRs, so 30 comments on one PR isn't 30 PRs' worth of review.
      prsTouched: new Set(theirs.map((r) => key(r.repo, r.prNumber))).size,
      authorsHelped: new Set(theirs.map((r) => r.prAuthor.toLowerCase())).size,
    },
  };
}

/** Which weeks a person has any activity in, newest first — drives the week
 * picker without loading a report per week. */
export function summarizeWeeks(
  login: string,
  prs: PullRequest[],
  reviews: ReviewActivity[],
): WeekSummary[] {
  const weeks = new Map<WeekId, WeekSummary>();
  const bump = (week: WeekId, field: keyof Omit<WeekSummary, "week">) => {
    const row = weeks.get(week) ?? { week, merged: 0, opened: 0, reviews: 0 };
    row[field] += 1;
    weeks.set(week, row);
  };

  for (const pr of prs) {
    if (!sameLogin(pr.author, login)) continue;
    bump(weekIdOf(pr.createdAt), "opened");
    if (pr.mergedAt !== null) bump(weekIdOf(pr.mergedAt), "merged");
  }
  for (const r of reviews) {
    if (!sameLogin(r.actor, login) || sameLogin(r.prAuthor, login)) continue;
    bump(weekIdOf(r.submittedAt), "reviews");
  }

  return [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week));
}
