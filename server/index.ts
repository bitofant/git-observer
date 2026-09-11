import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { loadConfig } from "./config.js";
import {
  addPerson,
  closeDb,
  getPerson,
  listPeople,
  pullRequestsInRange,
  pullRequestTimestamps,
  removePerson,
  reviewActivityInRange,
  reviewTimestamps,
  insightsFor,
} from "./db.js";
import { githubStatus } from "./github.js";
import { llmStatus, startLlmPolling } from "./llm.js";
import { resolveRepos, runSync, startSyncSchedule, syncState } from "./ingest.js";
import { buildWeeklyReport, summarizeWeeks } from "./rollup.js";
import { weekBounds, weekIdOf } from "../shared/week.js";
import type { Status } from "../shared/protocol.js";

// HTTP + static hosting on one port. Dev embeds Vite in middleware mode, so the
// UI, the API and HMR all live on the same origin and there is no proxy to keep
// in sync.
//
// There is NO authentication, by construction — the app binds to loopback and
// is reached through an SSH tunnel or a reverse proxy that does the
// authenticating. Do not add a "bind to 0.0.0.0" convenience flag without
// adding auth first: these dashboards name real people and their output.

const config = loadConfig();
const dev = process.argv.includes("--dev");
const PORT = config.server?.port ?? 4100;
const HOST = config.server?.host ?? "127.0.0.1";
const DIST = resolve(process.cwd(), "dist/web");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Every person's activity is read through the same two queries; a report is
 * then derived in memory (see rollup.ts — weeks are never stored). */
function reportFor(login: string, week: string) {
  const { start, end } = weekBounds(week);
  const prs = pullRequestsInRange([login], start, end);
  const reviews = reviewActivityInRange([login], start, end);
  const insights = insightsFor(prs.map((p) => ({ repo: p.repo, number: p.number })));
  return buildWeeklyReport(login, week, prs, reviews, insights);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;

  if (path === "/api/status" && req.method === "GET") {
    const gh = await githubStatus(config.github.command);
    const status: Status = {
      github: { ...gh, repos: await resolveRepos(config) },
      llm: llmStatus(),
      sync: syncState(),
    };
    sendJson(res, 200, status);
    return true;
  }

  if (path === "/api/people" && req.method === "GET") {
    sendJson(res, 200, listPeople());
    return true;
  }

  if (path === "/api/people" && req.method === "POST") {
    const body = (await readBody(req)) as {
      login?: unknown;
      displayName?: unknown;
    };
    const login = typeof body.login === "string" ? body.login.trim() : "";
    // A login is the join key for every ingested row, so validate its shape
    // here rather than letting a typo silently produce an empty dashboard.
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
      sendJson(res, 400, { error: "not a valid GitHub login" });
      return true;
    }
    const displayName =
      typeof body.displayName === "string" && body.displayName.trim()
        ? body.displayName.trim()
        : login;
    sendJson(res, 200, addPerson(login, displayName));
    return true;
  }

  const personMatch = /^\/api\/people\/([A-Za-z0-9-]{1,39})$/.exec(path);
  if (personMatch && req.method === "DELETE") {
    removePerson(personMatch[1]);
    sendJson(res, 200, { ok: true });
    return true;
  }

  const weeksMatch = /^\/api\/people\/([A-Za-z0-9-]{1,39})\/weeks$/.exec(path);
  if (weeksMatch && req.method === "GET") {
    const login = weeksMatch[1];
    if (!getPerson(login)) {
      sendJson(res, 404, { error: "unknown person" });
      return true;
    }
    // Read only timestamps to build the picker — loading every PR row of a
    // multi-year history just to bucket it would be wasteful.
    const prs = pullRequestsInRange([login], 0, Number.MAX_SAFE_INTEGER);
    const reviews = reviewActivityInRange([login], 0, Number.MAX_SAFE_INTEGER);
    sendJson(res, 200, summarizeWeeks(login, prs, reviews));
    return true;
  }

  const reportMatch = /^\/api\/people\/([A-Za-z0-9-]{1,39})\/week$/.exec(path);
  if (reportMatch && req.method === "GET") {
    const login = reportMatch[1];
    if (!getPerson(login)) {
      sendJson(res, 404, { error: "unknown person" });
      return true;
    }
    const week = url.searchParams.get("week") || weekIdOf(Date.now());
    try {
      sendJson(res, 200, reportFor(login, week));
    } catch {
      sendJson(res, 400, { error: "bad week id" });
    }
    return true;
  }

  if (path === "/api/sync" && req.method === "POST") {
    // Fire and forget: a manual sync can take minutes, and runSync is
    // single-flight, so the response says "started", never "finished".
    void runSync(config);
    sendJson(res, 202, { started: true });
    return true;
  }

  return false;
}

function serveStatic(res: ServerResponse, pathname: string): void {
  // Wrapped in try/catch on purpose: dist/web can vanish mid-rebuild, and an
  // ENOENT thrown out of an async handler would kill the process.
  try {
    const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, rel);
    if (!file.startsWith(DIST)) file = join(DIST, "index.html");
    let stat = statSync(file, { throwIfNoEntry: false });
    // SPA fallback: any unknown path renders the app shell.
    if (!stat?.isFile()) file = join(DIST, "index.html");
    stat = statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      res.writeHead(503).end("frontend not built — run npm run build");
      return;
    }
    const body = readFileSync(file);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(503).end("frontend unavailable");
  }
}

async function main(): Promise<void> {
  startLlmPolling(config.llm);
  startSyncSchedule(config);

  // In dev, Vite runs as middleware inside this server (single port, HMR).
  const vite = dev
    ? await (await import("vite")).createServer({
        server: { middlewareMode: true },
        appType: "spa",
      })
    : null;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url)
        .then((handled) => {
          if (!handled) sendJson(res, 404, { error: "not found" });
        })
        .catch((err) => sendJson(res, 500, { error: String(err?.message ?? err) }));
      return;
    }
    if (vite) {
      vite.middlewares(req, res, () => serveStatic(res, url.pathname));
      return;
    }
    serveStatic(res, url.pathname);
  });

  server.listen(PORT, HOST, () => {
    console.log(`git-observer listening on http://${HOST}:${PORT}${dev ? " (dev)" : ""}`);
  });

  const shutdown = () => {
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Log and continue: a background sync failure must never take the server down.
  process.on("uncaughtException", (err) => console.error("uncaught:", err));
  process.on("unhandledRejection", (err) => console.error("unhandled:", err));
}

void main();
