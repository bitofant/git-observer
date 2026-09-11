import { describe, expect, it } from "vitest";
import {
  normalizeState,
  parseJsonStream,
  parsePrPage,
  parseRepoList,
  parseReviewComments,
  splitRepo,
} from "./github.js";

describe("parseJsonStream", () => {
  it("flattens a single page", () => {
    expect(parseJsonStream('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("flattens the concatenated arrays `gh api --paginate` emits", () => {
    // This is the whole reason the function exists: the combined output is not
    // valid JSON, so a plain JSON.parse loses every multi-page result.
    const text = '[{"a":1}]\n[{"a":2}]\n[{"a":3}]';
    expect(() => JSON.parse(text)).toThrow();
    expect(parseJsonStream(text)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it("is not confused by brackets inside strings", () => {
    expect(parseJsonStream('[{"n":"a][b"}]\n[{"n":"c"}]')).toEqual([
      { n: "a][b" },
      { n: "c" },
    ]);
  });

  it("is not confused by escaped quotes", () => {
    expect(parseJsonStream('[{"n":"say \\"]\\" now"}]')).toEqual([
      { n: 'say "]" now' },
    ]);
  });

  it("keeps what parsed when output is truncated mid-value", () => {
    expect(parseJsonStream('[{"a":1}]\n[{"a":2')).toEqual([{ a: 1 }]);
  });

  it("returns empty for blank output", () => {
    expect(parseJsonStream("")).toEqual([]);
    expect(parseJsonStream("   \n ")).toEqual([]);
  });
});

describe("splitRepo", () => {
  it("splits an owner/name reference", () => {
    expect(splitRepo("octo/hello-world")).toEqual({
      owner: "octo",
      name: "hello-world",
    });
  });

  it("rejects anything that isn't one", () => {
    for (const bad of ["", "octo", "octo/a/b", "octo /a", "http://x/y"])
      expect(splitRepo(bad)).toBeNull();
  });
});

describe("normalizeState", () => {
  it("reports merged whenever there is a merge time", () => {
    // GitHub reports a merged PR as CLOSED; showing that as "closed" would
    // undercount every merge.
    expect(normalizeState("CLOSED", 1)).toBe("merged");
    expect(normalizeState("MERGED", 1)).toBe("merged");
  });

  it("distinguishes closed-unmerged from open", () => {
    expect(normalizeState("CLOSED", null)).toBe("closed");
    expect(normalizeState("OPEN", null)).toBe("open");
  });
});

const page = (nodes: unknown[], pageInfo = {}) => ({
  data: {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null, ...pageInfo },
        nodes,
      },
    },
  },
});

const prNode = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Add retry to the sync loop",
  url: "https://github.com/o/r/pull/7",
  state: "MERGED",
  createdAt: "2026-09-07T09:00:00Z",
  updatedAt: "2026-09-09T09:00:00Z",
  mergedAt: "2026-09-09T09:00:00Z",
  closedAt: "2026-09-09T09:00:00Z",
  additions: 40,
  deletions: 5,
  changedFiles: 3,
  author: { login: "alice" },
  reviews: { nodes: [] },
  comments: { nodes: [] },
  ...over,
});

describe("parsePrPage", () => {
  it("maps a pull request onto the protocol shape", () => {
    const { prs } = parsePrPage("o/r", page([prNode()]));
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      repo: "o/r",
      number: 7,
      author: "alice",
      state: "merged",
      additions: 40,
      deletions: 5,
      changedFiles: 3,
    });
    expect(prs[0].mergedAt).toBe(Date.parse("2026-09-09T09:00:00Z"));
  });

  it("skips a PR whose author was deleted rather than throwing", () => {
    // One unattributable PR must never abort a whole repo's sync.
    const { prs } = parsePrPage("o/r", page([prNode({ author: null })]));
    expect(prs).toEqual([]);
  });

  it("survives entirely malformed payloads", () => {
    for (const junk of [null, {}, { data: {} }, { data: { repository: null } }]) {
      const out = parsePrPage("o/r", junk);
      expect(out.prs).toEqual([]);
      expect(out.hasNextPage).toBe(false);
    }
  });

  it("extracts reviews and comments, tagging the PR's author", () => {
    const { reviews } = parsePrPage(
      "o/r",
      page([
        prNode({
          reviews: {
            nodes: [
              {
                id: "R1",
                state: "APPROVED",
                submittedAt: "2026-09-08T10:00:00Z",
                url: "u1",
                author: { login: "bob" },
              },
            ],
          },
          comments: {
            nodes: [
              {
                id: "C1",
                createdAt: "2026-09-08T11:00:00Z",
                url: "u2",
                author: { login: "carol" },
              },
            ],
          },
        }),
      ]),
    );
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({
      actor: "bob",
      kind: "review",
      state: "approved",
      prAuthor: "alice",
      prNumber: 7,
    });
    expect(reviews[1]).toMatchObject({
      actor: "carol",
      kind: "comment",
      state: null,
    });
  });

  it("drops a PENDING review — an unsubmitted draft is not activity", () => {
    const { reviews } = parsePrPage(
      "o/r",
      page([
        prNode({
          reviews: {
            nodes: [
              {
                id: "R1",
                state: "PENDING",
                submittedAt: null,
                url: "u",
                author: { login: "bob" },
              },
            ],
          },
        }),
      ]),
    );
    expect(reviews).toEqual([]);
  });

  it("reports the oldest updatedAt so the sync knows when to stop", () => {
    const out = parsePrPage(
      "o/r",
      page([
        prNode({ number: 8, updatedAt: "2026-09-09T00:00:00Z" }),
        prNode({ number: 9, updatedAt: "2026-09-01T00:00:00Z" }),
      ]),
    );
    expect(out.oldestUpdatedAt).toBe(Date.parse("2026-09-01T00:00:00Z"));
  });

  it("passes through pagination info", () => {
    const out = parsePrPage(
      "o/r",
      page([], { hasNextPage: true, endCursor: "CUR" }),
    );
    expect(out).toMatchObject({ hasNextPage: true, endCursor: "CUR" });
  });
});

describe("parseReviewComments", () => {
  const parents = new Map([
    ["R1", { repo: "o/r", prNumber: 7, prAuthor: "alice" }],
  ]);
  const comment = (over: Record<string, unknown> = {}) => ({
    id: "IC1",
    createdAt: "2026-09-08T09:00:00Z",
    publishedAt: "2026-09-08T10:00:00Z",
    url: "https://github.com/o/r/pull/7#discussion_r1",
    author: { login: "bob" },
    ...over,
  });
  const nodes = (list: unknown[]) => ({ data: { nodes: list } });

  it("maps inline comments onto their review's PR", () => {
    const rows = parseReviewComments(
      nodes([{ id: "R1", comments: { nodes: [comment()] } }]),
      parents,
    );
    expect(rows).toEqual([
      {
        id: "IC1",
        repo: "o/r",
        prNumber: 7,
        prAuthor: "alice",
        actor: "bob",
        kind: "inline",
        state: null,
        submittedAt: Date.parse("2026-09-08T10:00:00Z"),
        url: "https://github.com/o/r/pull/7#discussion_r1",
      },
    ]);
  });

  it("buckets on publishedAt, not the earlier draft createdAt", () => {
    // A batch review's comments are drafted before the review is submitted.
    const [row] = parseReviewComments(
      nodes([{ id: "R1", comments: { nodes: [comment()] } }]),
      parents,
    );
    expect(row.submittedAt).toBe(Date.parse("2026-09-08T10:00:00Z"));
    const [fallback] = parseReviewComments(
      nodes([
        { id: "R1", comments: { nodes: [comment({ publishedAt: null })] } },
      ]),
      parents,
    );
    expect(fallback.submittedAt).toBe(Date.parse("2026-09-08T09:00:00Z"));
  });

  it("skips comments whose review isn't a known parent", () => {
    // Unknown parent = nothing to attribute to (e.g. a dropped PENDING review).
    expect(
      parseReviewComments(
        nodes([{ id: "R9", comments: { nodes: [comment()] } }]),
        parents,
      ),
    ).toEqual([]);
  });

  it("skips unattributable comments and survives junk", () => {
    expect(
      parseReviewComments(
        nodes([
          null,
          { id: "R1", comments: null },
          {
            id: "R1",
            comments: {
              nodes: [
                comment({ author: null }),
                comment({ id: "" }),
                comment({ publishedAt: null, createdAt: null }),
              ],
            },
          },
        ]),
        parents,
      ),
    ).toEqual([]);
    for (const junk of [null, {}, { data: null }, { data: { nodes: null } }])
      expect(parseReviewComments(junk, parents)).toEqual([]);
  });
});

describe("parseRepoList", () => {
  it("keeps full names and drops archived repos", () => {
    expect(
      parseRepoList([
        { full_name: "o/a" },
        { full_name: "o/b", archived: true },
        { full_name: "o/c", archived: false },
        { name: "no-full-name" },
        null,
      ]),
    ).toEqual(["o/a", "o/c"]);
  });
});
