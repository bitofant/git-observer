import { describe, expect, it } from "vitest";
import {
  buildClassifyPrompt,
  extractJson,
  inputHash,
  parseClassification,
  sanitizeSize,
  sanitizeSummary,
} from "./classify.js";
import type { PullRequest } from "../shared/protocol.js";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  repo: "o/r",
  number: 7,
  title: "Add retry to the sync loop",
  author: "alice",
  state: "merged",
  url: "https://github.com/o/r/pull/7",
  createdAt: 0,
  mergedAt: 1,
  closedAt: 1,
  additions: 40,
  deletions: 5,
  changedFiles: 3,
  ...over,
});

describe("sanitizeSize", () => {
  it("accepts the four known sizes, case/space tolerant", () => {
    expect(sanitizeSize("large")).toBe("large");
    expect(sanitizeSize(" Medium ")).toBe("medium");
    expect(sanitizeSize("TRIVIAL")).toBe("trivial");
  });

  it("rejects anything invented, rather than coercing it", () => {
    // A coerced size would silently skew every weekly count.
    for (const bad of ["extra-large", "XS", "huge", "", null, 3, undefined])
      expect(sanitizeSize(bad)).toBeNull();
  });
});

describe("sanitizeSummary", () => {
  it("collapses whitespace and capitalizes", () => {
    expect(sanitizeSummary("  adds a  retry\nloop ")).toBe("Adds a retry loop");
  });

  it("strips the boilerplate openers models reach for", () => {
    expect(sanitizeSummary("This PR adds a retry loop")).toBe(
      "Adds a retry loop",
    );
    expect(sanitizeSummary("This pull request is adding retries")).toBe(
      "Adding retries",
    );
    expect(sanitizeSummary("Summary: adds retries")).toBe("Adds retries");
  });

  it("strips wrapping quotes", () => {
    expect(sanitizeSummary('"Adds retries"')).toBe("Adds retries");
  });

  it("rejects an over-long answer", () => {
    expect(sanitizeSummary("x".repeat(161))).toBeNull();
  });

  it("rejects a reply that echoed its JSON envelope instead of answering", () => {
    expect(sanitizeSummary('{"summary": "adds retries"}')).toBeNull();
    expect(sanitizeSummary("[adds retries]")).toBeNull();
  });

  it("unwraps a backtick-quoted summary rather than rejecting it", () => {
    expect(sanitizeSummary("`adds retries`")).toBe("Adds retries");
  });

  it("keeps code identifiers inside otherwise fine prose", () => {
    expect(sanitizeSummary("Adds `retry()` to the sync loop")).toBe(
      "Adds `retry()` to the sync loop",
    );
  });

  it("rejects empty and non-string input", () => {
    for (const bad of ["", "   ", null, 42, undefined])
      expect(sanitizeSummary(bad)).toBeNull();
  });
});

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"size":"small"}')).toEqual({ size: "small" });
  });

  it("digs the object out of a fenced block", () => {
    expect(extractJson('```json\n{"size":"small"}\n```')).toEqual({
      size: "small",
    });
  });

  it("digs it out from behind a model's preamble", () => {
    expect(
      extractJson('Let me think. The change is contained.\n{"size":"small"}'),
    ).toEqual({ size: "small" });
  });

  it("returns null on junk rather than throwing", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("{not json}")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("parseClassification", () => {
  it("accepts a well-formed reply", () => {
    expect(
      parseClassification('{"size":"medium","summary":"Adds retries to sync"}'),
    ).toEqual({ size: "medium", summary: "Adds retries to sync" });
  });

  it("requires BOTH halves to validate", () => {
    // A size with no summary is a half-filled card; a summary with an invented
    // size would corrupt the counts. Neither is worth keeping.
    expect(parseClassification('{"size":"medium"}')).toBeNull();
    expect(parseClassification('{"summary":"Adds retries"}')).toBeNull();
    expect(
      parseClassification('{"size":"gigantic","summary":"Adds retries"}'),
    ).toBeNull();
  });

  it("returns null for a reply that ignored the format", () => {
    expect(parseClassification("I think this one is medium sized.")).toBeNull();
  });
});

describe("inputHash", () => {
  it("is stable for identical content", () => {
    expect(inputHash(pr(), "body", ["a.ts"])).toBe(
      inputHash(pr(), "body", ["a.ts"]),
    );
  });

  it("changes when anything the model saw changed", () => {
    const base = inputHash(pr(), "body", ["a.ts"]);
    expect(inputHash(pr({ title: "Other" }), "body", ["a.ts"])).not.toBe(base);
    expect(inputHash(pr(), "different", ["a.ts"])).not.toBe(base);
    expect(inputHash(pr({ additions: 41 }), "body", ["a.ts"])).not.toBe(base);
    expect(inputHash(pr(), "body", ["a.ts", "b.ts"])).not.toBe(base);
  });

  it("ignores fields the model never saw", () => {
    // Re-classifying because a PR got merged would burn tokens for no change.
    expect(inputHash(pr({ mergedAt: 999, state: "open" }), "b", [])).toBe(
      inputHash(pr(), "b", []),
    );
  });
});

describe("buildClassifyPrompt", () => {
  it("includes the diffstat as evidence", () => {
    expect(buildClassifyPrompt(pr(), "why", ["a.ts"])).toContain(
      "+40 −5 across 3 file(s)",
    );
  });

  it("caps the file list so a huge PR can't blow the context window", () => {
    const files = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    const out = buildClassifyPrompt(pr(), "why", files);
    expect(out).toContain("…and 60 more");
    expect(out).not.toContain("f40.ts");
  });

  it("truncates a novel-length description", () => {
    const out = buildClassifyPrompt(pr(), "x".repeat(9000), []);
    expect(out.length).toBeLessThan(5000);
  });

  it("says so when there is no description", () => {
    expect(buildClassifyPrompt(pr(), "", [])).toContain("(none)");
  });
});
