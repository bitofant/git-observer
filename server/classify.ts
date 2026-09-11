import { createHash } from "node:crypto";
import { PR_SIZES, type PrSize, type PullRequest } from "../shared/protocol.js";
import { ask, llmStatus } from "./llm.js";
import { insightIsStale, saveInsight } from "./db.js";

// Turns a pull request into a size bucket + a one-sentence summary.
//
// Why an LLM rather than a diff-size threshold: size here means "how much
// thought did this take", and line counts get that backwards constantly — a
// 900-line lockfile bump or a generated-file rename is trivial, while a 15-line
// change to an auth check is large. The diffstat is given to the model as
// *evidence*, not as the answer.
//
// The model is never trusted directly: every field it returns is validated by
// the pure sanitizers below or the whole insight is rejected. A rejected
// classification leaves the PR unclassified, which the UI shows honestly as
// "unclassified" — it never falls back to a guessed size.

/** Longest summary we keep. A summary is one sentence at a glance-able length;
 * anything longer means the model wrote prose and ignored the instruction. */
const MAX_SUMMARY_CHARS = 160;

const SYSTEM = `You classify pull requests for an engineering activity dashboard.

Given a pull request's title, description, changed files and diff statistics,
reply with ONLY a JSON object:

{"size": "trivial"|"small"|"medium"|"large", "summary": "<one sentence>"}

Size means how much engineering thought the change represents, NOT how many
lines it touches:
- trivial: mechanical or generated — dependency bumps, formatting, renames,
  typo fixes, lockfiles. May be thousands of lines.
- small: a contained change to one behaviour, low risk, easy to review.
- medium: several coordinated changes, a new endpoint or component, or a
  non-obvious fix requiring real context.
- large: architectural change, cross-cutting refactor, new subsystem, or
  anything demanding careful review of subtle behaviour. May be few lines.

The summary is ONE sentence describing WHAT the change does at a high level, in
plain language, for someone skimming a weekly report. No preamble, no "This PR",
no file names, no implementation detail.`;

/** What the model is shown. Deliberately not the diff itself: a full diff blows
 * the context window on a large PR and costs far more than the judgement is
 * worth, while title + body + file list + diffstat is what a human skims. */
export function buildClassifyPrompt(
  pr: PullRequest,
  body: string,
  files: string[],
): string {
  const fileList = files.slice(0, 40);
  const more = files.length - fileList.length;
  return [
    `Repository: ${pr.repo}`,
    `Title: ${pr.title}`,
    `Diff: +${pr.additions} −${pr.deletions} across ${pr.changedFiles} file(s)`,
    "",
    "Description:",
    (body || "(none)").slice(0, 4000),
    "",
    "Changed files:",
    ...fileList.map((f) => `- ${f}`),
    ...(more > 0 ? [`- …and ${more} more`] : []),
  ].join("\n");
}

/** The identity of what was classified. A PR whose title, body, diffstat or
 * file list changed is stale and gets re-judged; an untouched one is never paid
 * for twice, even across a database rebuild. */
export function inputHash(
  pr: PullRequest,
  body: string,
  files: string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        pr.title,
        body,
        pr.additions,
        pr.deletions,
        pr.changedFiles,
        files,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Accept a size only if it is exactly one of ours. A model that invents
 * "extra-large" or "XS" must yield no insight, not a coerced one. */
export function sanitizeSize(raw: unknown): PrSize | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (PR_SIZES as string[]).includes(v) ? (v as PrSize) : null;
}

/** One clean sentence, or null. Strips the boilerplate openers models reach for
 * ("This PR ...") so summaries in a list stay scannable and don't all start the
 * same way. */
export function sanitizeSummary(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/^["'`]|["'`]$/g, "").trim();
  s = s.replace(
    /^(this\s+(pr|pull\s+request|change|commit)\s+)(is\s+|does\s+)?/i,
    "",
  );
  s = s.replace(/^(summary|answer)\s*[:—-]\s*/i, "");
  if (!s) return null;
  if (s.length > MAX_SUMMARY_CHARS) return null;
  // Braces mean the model echoed its JSON envelope instead of answering.
  // Backticks are deliberately NOT rejected: `retry()` inside an otherwise
  // fine sentence is normal prose, and the wrapping case is already unwrapped
  // above.
  if (/[{}]|^\s*\[/.test(s)) return null;
  return s[0].toUpperCase() + s.slice(1);
}

/** Pull the JSON object out of a reply that may be fenced or prefaced with
 * reasoning. Returns null rather than throwing — a garbled reply is a normal
 * outcome with a small local model. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface Classification {
  size: PrSize;
  summary: string;
}

/** Parse + validate a raw model reply. Pure, so the whole trust boundary is
 * testable without an endpoint. */
export function parseClassification(text: string): Classification | null {
  const obj = extractJson(text) as { size?: unknown; summary?: unknown } | null;
  if (!obj) return null;
  const size = sanitizeSize(obj.size);
  const summary = sanitizeSummary(obj.summary);
  // Both halves or nothing: a size with no summary is a half-filled card, and a
  // summary with an invented size would silently skew every weekly count.
  return size && summary ? { size, summary } : null;
}

/** Classify one PR and persist the insight. Best-effort: returns false when
 * there's no endpoint or the reply didn't validate, leaving the PR
 * unclassified for a later pass. */
export async function classifyPullRequest(
  pr: PullRequest,
  body: string,
  files: string[],
): Promise<boolean> {
  if (!llmStatus().available) return false;
  const hash = inputHash(pr, body, files);
  if (!insightIsStale(pr.repo, pr.number, hash)) return false;

  const reply = await ask(SYSTEM, buildClassifyPrompt(pr, body, files));
  if (!reply) return false;
  const parsed = parseClassification(reply.text);
  if (!parsed) return false;

  saveInsight({
    repo: pr.repo,
    number: pr.number,
    size: parsed.size,
    summary: parsed.summary,
    model: reply.model,
    inputHash: hash,
    classifiedAt: Date.now(),
  });
  return true;
}
