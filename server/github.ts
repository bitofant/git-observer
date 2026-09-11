import { execFile } from "node:child_process";
import type { PullRequest, ReviewActivity } from "../shared/protocol.js";

// The GitHub boundary: every call to the outside world goes through here, and
// nothing above this file knows that `gh` exists. Same split as the rest of the
// server — a thin impure runner plus PURE parsers for its output, which is what
// keeps `npm test` free of subprocesses and network.

const CALL_TIMEOUT_MS = 60_000;

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run `gh`, never throwing. A failure is a value, because every caller wants
 * to degrade (skip a repo, report a status) rather than unwind. */
export function gh(
  command: string,
  args: string[],
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024, // a paginated org can be large
        // gh must never try to open a browser or ask a question: this runs
        // headless under systemd, where a prompt hangs until the timeout.
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? (err ? String(err.message) : ""),
        });
      },
    );
  });
}

// --- pure parsers ----------------------------------------------------------

/** `gh api --paginate` concatenates one JSON value PER PAGE rather than
 * emitting a single document, so `JSON.parse` fails on any multi-page result.
 * Parse the stream of values and flatten. Handles the single-page case too. */
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  const trimmed = text.trim();
  if (!trimmed) return out;
  let idx = 0;
  const decoder = new (class {
    // JSON.parse can't tell us where a value ended, so walk values with a
    // bracket-depth scan that respects strings and escapes.
    next(s: string, from: number): number {
      let depth = 0;
      let inStr = false;
      let escaped = false;
      for (let i = from; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) return i + 1;
        }
      }
      return -1;
    }
  })();
  while (idx < trimmed.length) {
    while (idx < trimmed.length && /\s/.test(trimmed[idx])) idx++;
    if (idx >= trimmed.length) break;
    const end = decoder.next(trimmed, idx);
    if (end < 0) break; // truncated output — keep what parsed
    try {
      const value = JSON.parse(trimmed.slice(idx, end));
      if (Array.isArray(value)) out.push(...value);
      else out.push(value);
    } catch {
      break;
    }
    idx = end;
  }
  return out;
}

/** "owner/name" → parts, or null when it isn't a repo reference. Rejecting the
 * malformed case here is what stops a typo becoming a confusing `gh` error. */
export function splitRepo(repo: string): { owner: string; name: string } | null {
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repo.trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asNumber = (v: unknown): number => (typeof v === "number" ? v : 0);
const asTime = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const login = (v: unknown): string =>
  asString((v as { login?: unknown } | null)?.login);

/** GraphQL reports OPEN/CLOSED/MERGED; the app's vocabulary is lowercase, and
 * "closed but merged" must read as merged. */
export function normalizeState(raw: unknown, mergedAt: number | null): PullRequest["state"] {
  if (mergedAt !== null) return "merged";
  return asString(raw).toUpperCase() === "CLOSED" ? "closed" : "open";
}

export interface PrPage {
  prs: PullRequest[];
  reviews: (ReviewActivity & { id: string })[];
  hasNextPage: boolean;
  endCursor: string | null;
  /** Oldest `updatedAt` on this page — the incremental sync stops once this
   * falls below the watermark (the query is ordered UPDATED_AT DESC). */
  oldestUpdatedAt: number | null;
}

/** Parse one page of the pull-request GraphQL query. Defensive throughout: a
 * missing field yields a skipped row, never a throw — one malformed PR must not
 * abort a whole repo's sync. */
export function parsePrPage(repo: string, payload: unknown): PrPage {
  const conn = (payload as never as Record<string, never>)?.["data"] as
    | { repository?: { pullRequests?: unknown } }
    | undefined;
  const prConn = conn?.repository?.pullRequests as
    | {
        pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
        nodes?: unknown[];
      }
    | undefined;

  const prs: PullRequest[] = [];
  const reviews: (ReviewActivity & { id: string })[] = [];
  let oldestUpdatedAt: number | null = null;

  for (const raw of prConn?.nodes ?? []) {
    const node = raw as Record<string, unknown>;
    const number = asNumber(node.number);
    const author = login(node.author);
    // A PR from a deleted account has a null author and can't be attributed.
    if (!number || !author) continue;

    const mergedAt = asTime(node.mergedAt);
    const createdAt = asTime(node.createdAt) ?? 0;
    const updatedAt = asTime(node.updatedAt);
    if (updatedAt !== null)
      oldestUpdatedAt =
        oldestUpdatedAt === null ? updatedAt : Math.min(oldestUpdatedAt, updatedAt);

    prs.push({
      repo,
      number,
      title: asString(node.title),
      author,
      state: normalizeState(node.state, mergedAt),
      url: asString(node.url),
      createdAt,
      mergedAt,
      closedAt: asTime(node.closedAt),
      additions: asNumber(node.additions),
      deletions: asNumber(node.deletions),
      changedFiles: asNumber(node.changedFiles),
    });

    const pushActivity = (
      n: Record<string, unknown>,
      kind: ReviewActivity["kind"],
    ) => {
      const actor = login(n.author);
      const at = asTime(n.submittedAt ?? n.createdAt);
      const id = asString(n.id);
      if (!actor || at === null || !id) return;
      // A review verdict of PENDING is an unsubmitted draft — not activity.
      const state = asString(n.state).toLowerCase();
      if (kind === "review" && state === "pending") return;
      reviews.push({
        id,
        repo,
        prNumber: number,
        prAuthor: author,
        actor,
        kind,
        state:
          kind === "review"
            ? state === "approved"
              ? "approved"
              : state === "changes_requested"
                ? "changes_requested"
                : "commented"
            : null,
        submittedAt: at,
        url: asString(n.url),
      });
    };

    const reviewNodes =
      ((node.reviews as { nodes?: unknown[] } | undefined)?.nodes ?? []) as unknown[];
    for (const r of reviewNodes) pushActivity(r as Record<string, unknown>, "review");

    const commentNodes =
      ((node.comments as { nodes?: unknown[] } | undefined)?.nodes ?? []) as unknown[];
    for (const c of commentNodes) pushActivity(c as Record<string, unknown>, "comment");
  }

  return {
    prs,
    reviews,
    hasNextPage: prConn?.pageInfo?.hasNextPage === true,
    endCursor:
      typeof prConn?.pageInfo?.endCursor === "string"
        ? prConn.pageInfo.endCursor
        : null,
    oldestUpdatedAt,
  };
}

/** The PR an inline comment attributes to, via its parent review. */
export type ReviewParent = Pick<ReviewActivity, "repo" | "prNumber" | "prAuthor">;

/** Inline code comments from a `nodes(ids:[review ids])` query. Keyed back to
 * the parent review, since a comment doesn't carry its PR's author. */
export function parseReviewComments(
  payload: unknown,
  parents: Map<string, ReviewParent>,
): (ReviewActivity & { id: string })[] {
  const out: (ReviewActivity & { id: string })[] = [];
  const list = (payload as { data?: { nodes?: unknown } } | null)?.data?.nodes;
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    const node = raw as Record<string, unknown> | null;
    const parent = parents.get(asString(node?.id));
    const comments = (node?.comments as { nodes?: unknown } | null)?.nodes;
    if (!parent || !Array.isArray(comments)) continue;
    for (const c of comments) {
      const n = c as Record<string, unknown> | null;
      const id = asString(n?.id);
      const actor = login(n?.author);
      // publishedAt: batch-review comments are drafted before they're visible.
      const at = asTime(n?.publishedAt) ?? asTime(n?.createdAt);
      if (!id || !actor || at === null) continue;
      out.push({
        id,
        repo: parent.repo,
        prNumber: parent.prNumber,
        prAuthor: parent.prAuthor,
        actor,
        kind: "inline",
        state: null,
        submittedAt: at,
        url: asString(n?.url),
      });
    }
  }
  return out;
}

/** Filenames from `gh api repos/{repo}/pulls/{n}/files`. */
export function parsePrFiles(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const name = asString((v as { filename?: unknown })?.filename);
    if (name) out.push(name);
  }
  return out;
}

/** Repo full-names from `gh api orgs/<org>/repos`, skipping archived ones (a
 * dormant repo contributes only noise to a weekly view). */
export function parseRepoList(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const repo = v as { full_name?: unknown; archived?: unknown };
    if (repo?.archived === true) continue;
    const name = asString(repo?.full_name);
    if (name) out.push(name);
  }
  return out;
}

// --- impure callers --------------------------------------------------------

/** One GraphQL page of pull requests, with their reviews and comments. Batched
 * this way because the REST list endpoint omits additions/deletions — fetching
 * those per PR would be one request each and exhaust the rate limit on a
 * backfill. */
const PR_QUERY = `
query($owner:String!, $name:String!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequests(first:50, orderBy:{field:UPDATED_AT, direction:DESC}, after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url state createdAt updatedAt mergedAt closedAt
        additions deletions changedFiles
        author { login }
        reviews(first:50) { nodes { id state submittedAt url author { login } } }
        comments(first:50) { nodes { id createdAt url author { login } } }
      }
    }
  }
}`;

export async function fetchPrPage(
  command: string,
  repo: string,
  cursor: string | null,
): Promise<PrPage | { error: string }> {
  const parts = splitRepo(repo);
  if (!parts) return { error: `not an owner/repo reference: ${repo}` };
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${PR_QUERY}`,
    "-F",
    `owner=${parts.owner}`,
    "-F",
    `name=${parts.name}`,
  ];
  if (cursor) args.push("-F", `cursor=${cursor}`);
  const res = await gh(command, args);
  if (!res.ok) return { error: firstLine(res.stderr) || "gh call failed" };
  try {
    return parsePrPage(repo, JSON.parse(res.stdout));
  } catch {
    return { error: "unparseable gh output" };
  }
}

/** Inline comments live under reviews, not the PR's `comments`. Fetched by
 * review id rather than nested in PR_QUERY: nesting costs 26 rate-limit points
 * per page (charged per *possible* review), this ~1 per 100 reviews that exist. */
const REVIEW_COMMENTS_QUERY = `
query($ids:[ID!]!) {
  nodes(ids:$ids) {
    ... on PullRequestReview {
      id
      comments(first:50) { nodes { id createdAt publishedAt url author { login } } }
    }
  }
}`;
const NODES_PER_QUERY = 100; // GitHub's cap on nodes(ids:)

export async function fetchReviewComments(
  command: string,
  reviews: (ReviewActivity & { id: string })[],
): Promise<(ReviewActivity & { id: string })[] | { error: string }> {
  const parents = new Map<string, ReviewParent>();
  for (const r of reviews)
    if (r.kind === "review")
      parents.set(r.id, { repo: r.repo, prNumber: r.prNumber, prAuthor: r.prAuthor });
  const ids = [...parents.keys()];
  const out: (ReviewActivity & { id: string })[] = [];
  for (let i = 0; i < ids.length; i += NODES_PER_QUERY) {
    const args = ["api", "graphql", "-f", `query=${REVIEW_COMMENTS_QUERY}`];
    for (const id of ids.slice(i, i + NODES_PER_QUERY)) args.push("-f", `ids[]=${id}`);
    const res = await gh(command, args);
    if (!res.ok) return { error: firstLine(res.stderr) || "gh call failed" };
    try {
      out.push(...parseReviewComments(JSON.parse(res.stdout), parents));
    } catch {
      return { error: "unparseable gh output" };
    }
  }
  return out;
}

/** Body + changed filenames for one PR — the extra context the classifier
 * needs. Deliberately fetched per PR rather than in the list query: bodies and
 * file lists are unbounded, and this runs only ONCE per PR (the insight is
 * cached by content hash), whereas the list query re-runs every sync. */
export async function fetchPrDetail(
  command: string,
  repo: string,
  number: number,
): Promise<{ body: string; files: string[] } | null> {
  if (!splitRepo(repo)) return null;
  const [detail, files] = await Promise.all([
    gh(command, ["api", `repos/${repo}/pulls/${number}`]),
    gh(command, ["api", `repos/${repo}/pulls/${number}/files?per_page=100`]),
  ]);
  if (!detail.ok) return null;
  let body = "";
  try {
    body = asString((JSON.parse(detail.stdout) as { body?: unknown }).body);
  } catch {
    return null;
  }
  // A missing file list still leaves title+body+diffstat worth classifying.
  return {
    body,
    files: files.ok ? parsePrFiles(parseJsonStream(files.stdout)) : [],
  };
}

export async function listOrgRepos(
  command: string,
  org: string,
): Promise<string[]> {
  const res = await gh(command, [
    "api",
    "--paginate",
    `orgs/${org}/repos?per_page=100&type=all`,
  ]);
  if (!res.ok) return [];
  return parseRepoList(parseJsonStream(res.stdout));
}

/** Is `gh` present and authenticated? Returns a human-readable reason when not,
 * which the status endpoint surfaces — an unauthenticated gh is the single most
 * common reason the app looks empty. */
export async function githubStatus(
  command: string,
): Promise<{ available: boolean; detail: string | null }> {
  const res = await gh(command, ["auth", "status"], 15_000);
  if (res.ok) return { available: true, detail: null };
  const reason = firstLine(res.stderr) || firstLine(res.stdout);
  if (/ENOENT|not found/i.test(reason))
    return { available: false, detail: `${command} not found on PATH` };
  return { available: false, detail: reason || `${command} is not authenticated` };
}

export function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}
