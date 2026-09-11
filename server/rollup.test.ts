import { describe, expect, it } from "vitest";
import { buildWeeklyReport, summarizeWeeks, withInsights } from "./rollup.js";
import type {
  PrInsight,
  PullRequest,
  ReviewActivity,
} from "../shared/protocol.js";

const WEEK = "2026-W37"; // Mon 2026-09-07 .. Sun 2026-09-13 UTC
const at = (iso: string) => Date.parse(iso);
const IN = at("2026-09-09T12:00:00Z");
const BEFORE = at("2026-09-06T23:59:59Z");
const AFTER = at("2026-09-14T00:00:00Z");

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  repo: "o/r",
  number: 1,
  title: "t",
  author: "alice",
  state: "merged",
  url: "u",
  createdAt: IN,
  mergedAt: IN,
  closedAt: IN,
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  ...over,
});

const review = (over: Partial<ReviewActivity> = {}): ReviewActivity => ({
  repo: "o/r",
  prNumber: 99,
  prAuthor: "bob",
  actor: "alice",
  kind: "review",
  state: "approved",
  submittedAt: IN,
  url: "u",
  ...over,
});

const insight = (over: Partial<PrInsight> = {}): PrInsight => ({
  repo: "o/r",
  number: 1,
  size: "medium",
  summary: "Does a thing",
  model: "m",
  classifiedAt: 0,
  ...over,
});

const report = (
  prs: PullRequest[] = [],
  reviews: ReviewActivity[] = [],
  insights: [string, PrInsight][] = [],
) => buildWeeklyReport("alice", WEEK, prs, reviews, new Map(insights));

describe("buildWeeklyReport — authored", () => {
  it("buckets opened and merged independently", () => {
    const r = report([
      pr({ number: 1, createdAt: IN, mergedAt: null, state: "open" }),
      pr({ number: 2, createdAt: BEFORE, mergedAt: IN }),
    ]);
    expect(r.authored.opened.map((p) => p.number)).toEqual([1]);
    expect(r.authored.merged.map((p) => p.number)).toEqual([2]);
  });

  it("counts sizes over MERGED PRs only", () => {
    // A PR opened in one week and merged in another must not be counted twice.
    const r = report(
      [
        pr({ number: 1, createdAt: IN, mergedAt: IN }),
        pr({ number: 2, createdAt: IN, mergedAt: null, state: "open" }),
      ],
      [],
      [
        ["o/r#1", insight({ number: 1, size: "large" })],
        ["o/r#2", insight({ number: 2, size: "large" })],
      ],
    );
    expect(r.authored.sizes.large).toBe(1);
  });

  it("counts an unclassified PR as unknown, never as a guessed size", () => {
    const r = report([pr()]);
    expect(r.authored.sizes).toMatchObject({ unknown: 1, medium: 0 });
  });

  it("excludes activity outside the week on both edges", () => {
    const r = report([
      pr({ number: 1, createdAt: BEFORE, mergedAt: BEFORE }),
      pr({ number: 2, createdAt: AFTER, mergedAt: AFTER }),
    ]);
    expect(r.authored.opened).toEqual([]);
    expect(r.authored.merged).toEqual([]);
  });

  it("includes the very first and last instant of the week", () => {
    const r = report([
      pr({ number: 1, createdAt: r0(), mergedAt: null, state: "open" }),
      pr({ number: 2, createdAt: r1(), mergedAt: null, state: "open" }),
    ]);
    expect(r.authored.opened).toHaveLength(2);
  });

  it("ignores other people's PRs", () => {
    expect(report([pr({ author: "bob" })]).authored.merged).toEqual([]);
  });

  it("matches logins case-insensitively", () => {
    // GitHub logins are case-insensitive; two spellings must not split counts.
    expect(report([pr({ author: "ALICE" })]).authored.merged).toHaveLength(1);
  });

  it("sums the diffstat of merged work", () => {
    const r = report([
      pr({ number: 1, additions: 10, deletions: 2 }),
      pr({ number: 2, additions: 5, deletions: 1 }),
    ]);
    expect(r.authored.additions).toBe(15);
    expect(r.authored.deletions).toBe(3);
  });

  it("sorts newest first", () => {
    const r = report([
      pr({ number: 1, mergedAt: at("2026-09-08T00:00:00Z") }),
      pr({ number: 2, mergedAt: at("2026-09-11T00:00:00Z") }),
    ]);
    expect(r.authored.merged.map((p) => p.number)).toEqual([2, 1]);
  });
});

function r0() {
  return Date.parse("2026-09-07T00:00:00.000Z");
}
function r1() {
  return Date.parse("2026-09-13T23:59:59.999Z");
}

describe("buildWeeklyReport — reviewing", () => {
  it("counts reviews and comments on other people's PRs", () => {
    const r = report(
      [],
      [
        review({ kind: "review" }),
        review({ kind: "comment", state: null, prNumber: 98 }),
      ],
    );
    expect(r.reviewing).toMatchObject({ reviews: 1, comments: 1 });
  });

  it("excludes comments on the person's OWN PR", () => {
    // Otherwise a chatty author looks like an engaged reviewer.
    const r = report([], [review({ prAuthor: "alice", kind: "comment" })]);
    expect(r.reviewing).toMatchObject({ reviews: 0, comments: 0, prsTouched: 0 });
  });

  it("counts DISTINCT PRs touched, not raw comment volume", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      review({ kind: "comment", state: null, prNumber: 5, url: `u${i}` }),
    );
    const r = report([], many);
    expect(r.reviewing.comments).toBe(30);
    expect(r.reviewing.prsTouched).toBe(1);
  });

  it("counts distinct authors helped", () => {
    const r = report(
      [],
      [
        review({ prAuthor: "bob", prNumber: 1 }),
        review({ prAuthor: "BOB", prNumber: 2 }),
        review({ prAuthor: "carol", prNumber: 3 }),
      ],
    );
    expect(r.reviewing.authorsHelped).toBe(2);
  });

  it("excludes review activity outside the week", () => {
    expect(report([], [review({ submittedAt: BEFORE })]).reviewing.reviews).toBe(0);
  });

  it("ignores another person's reviews", () => {
    expect(report([], [review({ actor: "dave" })]).reviewing.reviews).toBe(0);
  });
});

describe("withInsights", () => {
  it("joins on repo and number", () => {
    const joined = withInsights(
      [pr({ number: 1 }), pr({ number: 2 })],
      new Map([["o/r#1", insight({ number: 1 })]]),
    );
    expect(joined[0].insight?.summary).toBe("Does a thing");
    expect(joined[1].insight).toBeNull();
  });

  it("does not join across repos with the same PR number", () => {
    const joined = withInsights(
      [pr({ repo: "o/other", number: 1 })],
      new Map([["o/r#1", insight()]]),
    );
    expect(joined[0].insight).toBeNull();
  });
});

describe("summarizeWeeks", () => {
  it("tallies per week, newest first", () => {
    const out = summarizeWeeks(
      "alice",
      [
        pr({ number: 1, createdAt: IN, mergedAt: IN }),
        pr({ number: 2, createdAt: BEFORE, mergedAt: null }),
      ],
      [review()],
    );
    expect(out.map((w) => w.week)).toEqual(["2026-W37", "2026-W36"]);
    expect(out[0]).toMatchObject({ opened: 1, merged: 1, reviews: 1 });
    expect(out[1]).toMatchObject({ opened: 1, merged: 0, reviews: 0 });
  });

  it("counts a PR in both the week it opened and the week it merged", () => {
    const out = summarizeWeeks(
      "alice",
      [pr({ createdAt: BEFORE, mergedAt: IN })],
      [],
    );
    expect(out.find((w) => w.week === "2026-W36")?.opened).toBe(1);
    expect(out.find((w) => w.week === "2026-W37")?.merged).toBe(1);
  });

  it("returns nothing for a person with no activity", () => {
    expect(summarizeWeeks("nobody", [pr()], [review()])).toEqual([]);
  });
});
