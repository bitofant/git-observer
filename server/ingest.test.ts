import { describe, expect, it } from "vitest";
import { ERROR_BACKOFF_MS, shouldSkipRepo } from "./ingest.js";

const NOW = Date.parse("2026-09-09T12:00:00Z");

describe("shouldSkipRepo", () => {
  it("never skips a repo that has never been synced", () => {
    expect(shouldSkipRepo(null, NOW)).toBe(false);
  });

  it("never skips a healthy repo, however recently it synced", () => {
    expect(
      shouldSkipRepo({ lastSyncedAt: NOW - 1000, lastError: null }, NOW),
    ).toBe(false);
  });

  it("skips a repo that failed inside the backoff window", () => {
    expect(
      shouldSkipRepo(
        { lastSyncedAt: NOW - ERROR_BACKOFF_MS / 2, lastError: "404" },
        NOW,
      ),
    ).toBe(true);
  });

  it("retries a failed repo once the backoff has elapsed", () => {
    expect(
      shouldSkipRepo(
        { lastSyncedAt: NOW - ERROR_BACKOFF_MS - 1, lastError: "404" },
        NOW,
      ),
    ).toBe(false);
  });
});
