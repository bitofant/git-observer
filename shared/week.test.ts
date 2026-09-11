import { describe, expect, it } from "vitest";
import {
  formatWeekRange,
  shiftWeek,
  weekBounds,
  weekIdOf,
  weekStart,
  weeksBetween,
} from "./week.js";

const utc = (s: string) => Date.parse(s);

describe("weekStart", () => {
  it("snaps to Monday midnight UTC", () => {
    expect(new Date(weekStart(utc("2026-09-09T13:45:00Z"))).toISOString()).toBe(
      "2026-09-07T00:00:00.000Z",
    );
  });

  it("treats Sunday as the LAST day of the week, not the first", () => {
    // The classic getUTCDay()==0 bug: a Sunday merge jumping a week forward.
    expect(new Date(weekStart(utc("2026-09-13T23:59:59Z"))).toISOString()).toBe(
      "2026-09-07T00:00:00.000Z",
    );
  });

  it("is idempotent on a Monday midnight", () => {
    const m = weekStart(utc("2026-09-07T00:00:00Z"));
    expect(weekStart(m)).toBe(m);
  });
});

describe("weekIdOf", () => {
  it("formats zero-padded ISO week ids", () => {
    expect(weekIdOf(utc("2026-01-05T00:00:00Z"))).toBe("2026-W02");
  });

  it("assigns a week to the year containing its Thursday", () => {
    // 2027-01-01 is a Friday, so that week's Thursday is 2026-12-31 → 2026-W53.
    expect(weekIdOf(utc("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    // 2025-12-29 is a Monday whose Thursday falls in 2026 → 2026-W01.
    expect(weekIdOf(utc("2025-12-29T12:00:00Z"))).toBe("2026-W01");
  });

  it("round-trips through weekBounds", () => {
    for (const iso of [
      "2026-09-09T13:45:00Z",
      "2026-01-01T00:00:00Z",
      "2024-02-29T23:00:00Z",
      "2027-12-31T23:59:59Z",
    ]) {
      const id = weekIdOf(utc(iso));
      const { start, end } = weekBounds(id);
      expect(weekIdOf(start)).toBe(id);
      expect(weekIdOf(end - 1)).toBe(id);
      expect(end - start).toBe(7 * 86_400_000);
    }
  });
});

describe("weekBounds", () => {
  it("rejects a malformed id rather than silently returning epoch", () => {
    expect(() => weekBounds("2026-W")).toThrow();
    expect(() => weekBounds("nonsense")).toThrow();
  });
});

describe("shiftWeek", () => {
  it("steps forward and back", () => {
    expect(shiftWeek("2026-W37", -1)).toBe("2026-W36");
    expect(shiftWeek("2026-W37", 1)).toBe("2026-W38");
  });

  it("crosses a year boundary onto a 53-week year", () => {
    expect(shiftWeek("2027-W01", -1)).toBe("2026-W53");
  });
});

describe("weeksBetween", () => {
  it("lists newest first, inclusive at both ends", () => {
    expect(weeksBetween("2026-W35", "2026-W37")).toEqual([
      "2026-W37",
      "2026-W36",
      "2026-W35",
    ]);
  });

  it("is order-insensitive in its arguments", () => {
    expect(weeksBetween("2026-W37", "2026-W35")).toEqual(
      weeksBetween("2026-W35", "2026-W37"),
    );
  });

  it("yields a single week when both ends match", () => {
    expect(weeksBetween("2026-W37", "2026-W37")).toEqual(["2026-W37"]);
  });
});

describe("formatWeekRange", () => {
  it("spans Monday to Sunday", () => {
    expect(formatWeekRange("2026-W37")).toBe("Mon 7 Sep – Sun 13 Sep 2026");
  });
});
