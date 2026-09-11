# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Everything in CLAUDE.md must be extremely terse: bulleted lists, not paragraphs, as concise and token-efficient as possible.**

**Keep this file correct: update it when details change, and add genuinely important architectural decisions as they're made.**

**Code comments must be extremely terse too: short one-liners explaining *why*, never restating the code. No prose blocks, no redundant JSDoc.**

## Project state

- Scaffolded. Working vertical slice: add people on the main menu, click through to a per-person weekly dashboard, backed by a real `gh` ingest and live LLM PR classification.
- Verified end-to-end against `bitofant/agent-remote`: 78 PRs ingested, classified into plausible sizes with accurate one-sentence summaries, weekly reports served over the API.
- TypeScript throughout. Tests use **Vitest** (`npm test`), co-located `*.test.ts` next to source, Node environment (`vitest.config.ts`). Coverage is the pure layer — `shared/week.test.ts` (ISO bucketing), `server/github.test.ts` (`gh` output parsers), `server/classify.test.ts` (LLM output trust boundary), `server/rollup.test.ts` (every number on the dashboard), `server/ingest.test.ts` (backoff). No network, no subprocesses, no tokens. Test files are excluded from `npm run typecheck` (both tsconfigs) so that gate stays scoped to shipping code; Vitest runs them.
- **Prefer TDD for anything in the pure layer** — a new aggregate metric, a new `gh` field, a new sanitizer. These have a clean observable contract (rows in → numbers out) that a pure test pins in milliseconds. Order: draft the test against the intended contract → implement → run the real thing and adjust the test to what GitHub/the model actually returns.
- **Not built:** commit-level ingest, any dashboard panel beyond the first pass, e2e tests (`vitest.e2e.config.ts` exists and is wired, but no `*.e2e.test.ts` yet).

## Commands

- `npm run dev` — single-process dev server (`tsx watch server/index.ts --dev`), Vite embedded as middleware.
- `npm run build` — production frontend build to `dist/web` (Vite).
- `npm start` — run server serving the prebuilt `dist/web`.
- `npm run sync` — one-shot ingest + classify from the CLI (`scripts/sync.ts`). Use for the first backfill and for debugging ingest without the server up.
- `npm run typecheck` — `tsc --noEmit` for web (`tsconfig.json`) + server (`tsconfig.server.json`).
- `npm test` — Vitest run (once, pure/fast). `npm run test:watch` for the watch loop. Excludes `*.e2e.test.ts`.
- `npm run test:e2e` — live tests (`vitest.e2e.config.ts`) that spawn real `gh` and/or call the LLM endpoint; must self-skip when either is unavailable. Kept out of `npm test`.
- Requires `config.json` (run `./config-gen.sh`) and an authenticated `gh` on `PATH`.
- Server is **never compiled** — `npm start` runs `tsx server/index.ts` directly. Only the frontend is built (`dist/web`).

## Deployment (systemd user service)

- `./install-service.sh` — one-time: writes/enables `~/.config/systemd/user/git-observer.service` (runs `npm start`), builds `dist/web` if missing, enables linger. User service (not system): `gh` reads per-user credentials from `$HOME`.
- `./start.sh` / `./stop.sh` / `./restart.sh` wrap `systemctl --user` as the canonical prod runner. `./restart.sh` rebuilds frontend then restarts.
- `./start.sh dev` is the exception: runs the `tsx watch` HMR server directly (pidfile + `setsid`, not systemd). `./stop.sh` prioritizes that pidfile if present, else stops the service.
- `./rebuild.sh` builds frontend only. Frontend change → rebuild + restart; server-only change → plain `systemctl --user restart git-observer`.
- **Unlike agent-remote, restarting is safe here** — no agent session lives inside this process, so you may run `./restart.sh` yourself. The restart-resilience machinery is still ported and must not be regressed:
  - `rebuild.sh` **stages + atomically swaps** (`vite build --outDir dist/web.next` → two `mv`s), so `emptyOutDir` never wipes `dist/web` under the live server.
  - `serveStatic` (`index.ts`) **try/catches the read** → 503, plus `uncaughtException`/`unhandledRejection` log-and-continue handlers. A missing `index.html` mid-rebuild would otherwise throw ENOENT out of a handler and kill the process.
  - `restart.sh` runs rebuild+restart in a **transient unit** (`systemd-run --user --collect`) outside the cgroup being torn down, and verifies the unit came back.
  - Unit has `Restart=always` + `StartLimitIntervalSec=0` (the default 5-starts/10s budget lets a crash-loop wedge it dead permanently) + `TimeoutStopSec=20` (a hung `gh` mustn't stall the stop half).

## Layout

- `shared/protocol.ts` — the REST contract, shared by both sides: `Person`, `PullRequest`, `PrInsight`/`PrWithInsight`, `ReviewActivity`, `WeeklyReport`, `WeekSummary`, `Status`, and the `PrSize` vocabulary (`trivial|small|medium|large`). No server-only types leak in.
- `shared/week.ts` — **the single bucketing rule the whole app agrees on**, pure. ISO-8601 weeks, Mon–Sun, **in UTC**.
  - Local-time bucketing was rejected outright: GitHub timestamps are UTC instants, and bucketing locally makes "last week" mean different things on two machines and shifts a Sunday-evening merge across the boundary depending on who's looking.
  - `weekIdOf` applies the **ISO year rule — a week belongs to the year containing its Thursday**, not its Monday. That's the classic New Year off-by-one (`2027-01-01` is in `2026-W53`), and it's pinned by tests.
  - `formatWeekRange` is **hand-rolled, deliberately not `toLocaleDateString`**: Intl output varies by Node's ICU build (one gives `Sep`, another `Sept`, and it injects a comma once a year is present), so the header wobbled between environments and the test was unpinnable. A week range is four fixed tokens — not worth a locale dependency. (This was a real failing test, not a hypothetical.)
- `server/github.ts` — **the GitHub boundary; nothing above this file knows `gh` exists.** Same split as everything else: a thin impure runner plus PURE parsers, which is what keeps `npm test` free of subprocesses and network.
  - `gh()` **never throws** — a failure is a value, because every caller wants to degrade (skip a repo, report a status) rather than unwind. Sets `GH_PROMPT_DISABLED=1` + `GH_PAGER=cat`: this runs headless under systemd, where a prompt hangs until the timeout.
  - **`parseJsonStream` exists because `gh api --paginate` emits one JSON value PER PAGE rather than one document** — the combined output is not valid JSON, so a plain `JSON.parse` silently loses every multi-page result. It walks values with a bracket-depth scan that respects strings and escapes, and keeps what parsed when output is truncated. Pinned by tests including the `]` -inside-a-string case.
  - **PR lists come from GraphQL, not REST**: the REST list endpoint omits `additions`/`deletions`/`changedFiles`, and fetching those per PR would be one request each and exhaust the rate limit on a backfill. One GraphQL page carries the PRs *plus* their reviews and conversation comments.
  - **Inline code comments come from a second query, `nodes(ids:[review ids])`, batched 100 per call** (`fetchReviewComments` / pure `parseReviewComments`), stored as `kind: "inline"`. **Never nest `reviews { comments }` into `PR_QUERY`**: GitHub charges per *possible* connection (50 PRs × 50 reviews), measured at 26 points/page vs 1. The batch costs ~1 point per 100 reviews that exist, 0 on a repo with none.
  - Inline comments bucket on **`publishedAt`**, not `createdAt` — a batch review's comments are drafted before they're visible (differed on 23/68 in a live sample).
  - `parsePrPage` is **defensive throughout** — a missing field yields a skipped row, never a throw. One malformed or deleted-author PR must not abort a whole repo's sync.
  - **`normalizeState` must report merged whenever there's a merge time.** GitHub reports a merged PR as `CLOSED`; taking that at face value undercounts every merge.
  - A **PENDING review is dropped** — it's an unsubmitted draft, not activity.
  - `fetchPrDetail` (body + filenames) is the **only** per-PR REST call, and runs **once per PR ever** because the insight is cached by content hash. The list query re-runs every sync; this doesn't.
- `server/ingest.ts` — the sync loop. Two properties matter more than speed:
  - **Incremental.** The GraphQL query is ordered `UPDATED_AT DESC`, so a sync walks pages only until a page's oldest `updatedAt` falls below the repo's watermark, then stops. Without it every sync re-walks all history and burns the rate limit for nothing.
  - **Degrades per repo.** One unreachable/renamed repo records its error on its own watermark row and the others still sync. A throw here would take the whole schedule down.
  - **A previously-failed repo has no trustworthy watermark** — its last run may have stopped anywhere — so it falls back to the backfill floor rather than resuming from a point nothing was actually ingested up to. On failure the row is stamped with the **attempt** time, not the unreached watermark, because that's what the backoff measures from.
  - A failed inline-comment fetch **fails the repo**, never skips: advancing the watermark past those PRs would lose their inline comments for good.
  - `runSync` is **single-flight**: a slow sync must never overlap the next tick, or two passes fight over the same rate limit and watermarks.
  - Bounds that keep one repo from monopolizing the loop: `MAX_PAGES_PER_REPO` (40 pages × 50), `CLASSIFY_BATCH` (25 PRs/pass — a backfill is spread over several runs rather than hammering both endpoints), `ERROR_BACKOFF_MS` (30 min, so a permanently broken entry costs one call per interval, not one per loop). `shouldSkipRepo` is pure and tested.
  - Re-syncs from `now - 60s`, so a PR updated *during* the sync doesn't fall in the gap between this watermark and the next run.
- `server/classify.ts` — the LLM trust boundary. **Size is LLM-judged, never derived from line counts**, because size here means "how much thought did this take" and line counts get that backwards constantly: a 900-line lockfile bump is trivial, a 15-line change to an auth check is large. The diffstat is given to the model as *evidence*, not as the answer.
  - **The model is never trusted directly.** `sanitizeSize` accepts only the four known values (an invented "extra-large" or "XS" yields nothing, never a coerced value that would skew every weekly count). `sanitizeSummary` collapses whitespace, strips the boilerplate openers models reach for (`This PR …`, `Summary: …`) so a list doesn't read as identical stanzas, unwraps quoting, and rejects an over-long answer or one that echoed the JSON envelope. Backticks are deliberately **not** rejected — `` `retry()` `` in an otherwise fine sentence is normal prose.
  - **`parseClassification` requires BOTH halves or nothing.** A size with no summary is a half-filled card; a summary with an invented size corrupts the counts.
  - **A rejected classification leaves the PR unclassified, which the UI shows honestly as "unclassified".** It never falls back to a guessed size. Same rule as a missing endpoint.
  - **The model sees title + body + file list + diffstat, never the diff.** A full diff blows the context window on a large PR and costs far more than the judgement is worth; this is what a human skims anyway. File list capped at 40, body at 4k chars.
  - **`inputHash` is the re-classification key** — a PR whose title/body/diffstat/files changed is stale and gets re-judged; an untouched one is never paid for twice, even across a database rebuild. It deliberately **ignores fields the model never saw** (`mergedAt`, `state`), or every merge would trigger a re-classification for no change.
- `server/rollup.ts` — weekly aggregation, **pure**, so every number on the dashboard is testable without a database.
  - **Weeks are DERIVED, never stored.** A materialized rollup table would be actively wrong, not merely redundant: a PR merged late, a re-classification after a title edit, or a person added months after the fact all retroactively change a past week, and a cached row has no way to know. SQLite grouping over a few thousand rows is far cheaper than the staleness bugs.
  - **Size counts run over MERGED PRs, not opened ones.** A PR opened one week and merged three weeks later belongs to the week it landed; counting it in both doubles every total. (`summarizeWeeks` *does* count both, on purpose — it's a "was there activity" index for the picker, not a metric.)
  - **Review activity means work on OTHER people's PRs.** Self-comments are a developer replying on their own PR — real, but not review of others, and counting them makes a chatty author look like an engaged reviewer.
  - **Distinct counts, not raw volume**: `prsTouched` and `authorsHelped` are sets, so 30 comments on one PR isn't 30 PRs' worth of review. Raw `reviews`/`comments`/`inlineComments` are kept alongside — both readings are useful, neither alone is honest.
  - **Logins are matched case-insensitively everywhere** (`sameLogin`, plus `COLLATE NOCASE` on the SQLite columns). GitHub logins are case-insensitive; two spellings of one person must never split a week's counts in half.
- `server/db.ts` — the only persistence layer. **Everything is a cache of GitHub except the `people` table**, which is the sole user-authored state — so `data/` can be deleted and re-synced, at the cost of re-classifying (which is why insights are keyed by content hash rather than time).
  - `pull_requests` keyed by `(repo, number)` — GitHub's own identity — so a re-sync upserts rather than duplicating.
  - `review_activity.pr_author` is **denormalized on purpose**: every query that matters asks "activity on someone else's PR", and carrying the author here turns that filter into a column compare instead of a join.
  - **`INGEST_VERSION` (SQLite `user_version`)**: bump it whenever ingest starts capturing new data. On open, an older DB has `sync_state` cleared, so the next sync re-walks `backfillDays` and old PRs gain the new rows. Without it, watermarks keep old PRs from ever being re-fetched.
  - **`removePerson` deliberately leaves ingested rows alone.** They're a login-keyed cache shared with every other person's review counts, and re-adding someone must not need a re-sync.
- `server/llm.ts` — OpenAI-compatible endpoint client (same `config.json` `llm` block shape as agent-remote). Polls `/models` for health; **any error degrades to "unavailable"** and the app then shows counts and diffstats with no insights rather than guessing. `ask()` returns null on any failure — **callers must treat null as "no opinion", never as a default answer**. One retry (endpoints fail transiently); 60s timeout because classification is a background job blocking nobody.
- `server/index.ts` — HTTP + static hosting on one port; dev embeds Vite in middleware mode so UI, API and HMR share an origin with no proxy to keep in sync. Routes: `GET /api/status`, `GET|POST /api/people`, `DELETE /api/people/:login`, `GET /api/people/:login/weeks`, `GET /api/people/:login/week?week=`, `POST /api/sync`.
  - **A login is validated on the way in** (`/^[A-Za-z0-9-]{1,39}$/`) — it's the join key for every ingested row, so a typo would otherwise silently produce a permanently empty dashboard.
  - `POST /api/sync` is **fire-and-forget** (202 "started", never "finished") — a manual sync takes minutes and `runSync` is single-flight anyway.
- `web/` — React app. `client.ts` (typed `fetch` wrappers), `App.tsx` (main menu: people list, `+ Add`, status bar), `PersonDashboard.tsx` (lazy-loaded, its own chunk), `styles.css`.
  - **The dashboard is a thin renderer.** Every number comes from the server's `WeeklyReport`, so there is exactly one definition of "merged this week" and the UI can't drift from it. Resist computing metrics client-side.
  - **Which person is open lives in the URL hash**, so a reload and a shared link both land on the same dashboard with no router dependency.
  - **Unclassified work is shown, never hidden or folded into a size** (the `unknown` segment + the "not classified" line) — otherwise a missing LLM silently shrinks someone's week.
  - The status bar names *why* something is degraded (`LLM offline — no PR insights`, `gh is not authenticated`) rather than looking broken. An unauthenticated `gh` is the single most common reason the app comes up empty.
  - Polling, not push: `App.tsx` refreshes status every 15s and **skips while `document.hidden`**, so a forgotten tab costs nothing.
- **Theming** (ported from agent-remote, same rules): the palette is **12 CSS vars + a 3-step radius scale in `styles.css`'s `:root`** and nothing else — every color resolves to one. **Never hardcode a hex or a raw radius in a component or rule.**
  - **Elevation, not outlines.** There is **no border colour in the palette at all**: surfaces separate by three background steps, `--bg` < `--panel` < `--raised`. **Nested content must rise, never sink** — a `--bg` fill inside a `--panel` card is the "sunken well" bug. State (hover/active/selected) uses an accent tint (`color-mix(… var(--accent) 10–20%, …)`), never a darker fill. **Adding a divider is the wrong reflex — change the elevation instead.**
  - **Controls are filled, never outlined.** A base `button,input,select,textarea { border: none }` reset makes borderless the floor — merely *deleting* a border declaration falls back to the UA's `border-style: outset`, i.e. a Windows-98 bevel. `select` additionally needs `appearance: none`. Since `--border` can't carry focus, **`:focus-visible` is a `box-shadow` ring** (a ring can't shift layout the way a border can); any new control must keep a non-border focus indicator.
  - **Radius scale is `--r-sm`/`--r-md`/`--r-lg` (4/8/12px)** and nested boxes stay **concentric**: `inner = outer − padding`.
  - Touch-reachable controls are **never hover-only** (`.person-remove` sits at `opacity:.4` always) — touch has no hover.
  - The cards grid is `repeat(auto-fit, minmax(min(320px,100%), 1fr))`; **320px is chosen so a 640px viewport can't fit two columns**, so phones stay single-column *by arithmetic*, with no second media query to keep in sync.
  - No `web/theme.ts` / ThemeEditor here (agent-remote needed the pub-sub for xterm, which takes colors as a JS object and can't follow CSS vars — there's no such consumer in this app). Add one only if a real need appears.

## What this is

- A per-developer dashboard over GitHub activity: who is working on what, and how much of it.
- Main menu lists tracked people (`+ Add` by GitHub login). Clicking one opens their weekly dashboard.
- The point of the LLM pass is that **a week of work should be skimmable without opening a single PR** — hence one sentence per PR and a size that reflects effort rather than line count.
- User-facing overview: `README.md`.

## Architecture (settled)

- **Frontend:** React + Vite. **Backend:** Node, no compile step.
- **Single port:** UI and `/api` on one port (default 4100). Dev embeds Vite in **middleware mode** (`--dev` flag, not env); prod serves `dist/web`.
- **No WebSocket, deliberately.** agent-remote needed one to stream PTY output; here the data changes when a background sync lands, on the order of minutes. Polling a cached snapshot is the honest shape and one less moving part. Don't add a socket for freshness the data doesn't have.
- **No authentication, by construction.** The server binds to **loopback** (`server.host`, default `127.0.0.1`) and is reached through an SSH tunnel or a reverse proxy that does the authenticating. **Do not add a "bind to 0.0.0.0" convenience flag without adding auth first** — these dashboards name real people and their output.
- **Pipeline:** `gh` → `server/github.ts` (parse) → `server/db.ts` (cache) → `server/classify.ts` (enrich) → `server/rollup.ts` (derive) → REST → React. Each stage is replaceable; only `github.ts` knows the forge.
- **Hard constraint:** keep forge-specific logic confined to `server/github.ts`. Supporting GitLab later = a second module behind the same shapes, never changes to rollup/UI/protocol. Leakage into shared code = design smell.
- **Pure ⟂ impure, everywhere.** Each module exports pure functions (parsers, sanitizers, aggregators, bucketing) plus a thin impure caller. That's what keeps `npm test` process-free and fast, and it's the pattern to follow for anything new.

## Config

- No env variables. All config lives in `config.json` (gitignored).
- `config-gen.sh` runs a setup dialog to generate it. Shape in `config.example.json`. It verifies `gh` is present *and authenticated* up front, since that's the usual failure.
- Keys: `github` (`command`, `repos[]`, `orgs[]`, `backfillDays`), `llm` (`provider`/`baseUrl`/`model`), `sync.intervalMinutes`, `server.port`/`server.host`.
- **No GitHub token in config** — `gh` brings its own auth. That's the main reason the CLI was chosen over raw REST.
- `orgs` expansion is best-effort and **skips archived repos** (a dormant repo contributes only noise to a weekly view); a failed expansion leaves the explicit `repos` syncing rather than emptying the list.
- Never reintroduce `process.env`-style config or `.env` files.

## LLM features

- **Built:** PR size classification + one-sentence summaries (`server/classify.ts`), via an OpenAI-compatible endpoint.
- **Planned (not built):** weekly narrative summary per person ("what X worked on last week" in a paragraph), theme/area clustering across a week, anomaly surfacing (unusual review load, stalled PRs).
- All of it must stay **optional and fail-safe**: no endpoint → fewer columns, never a blocked page or an invented number.

## Dashboard — open questions

The first-pass panels (merged/opened counts, size histogram, review stats, PR lists) are a starting point, not a settled design. Undecided, and worth deciding before adding more:

- **Is "bigger PRs" a count of large+medium, or should size be weighted?** Currently a raw count of the two.
- **Trend vs snapshot.** Everything is a single week today; a sparkline over recent weeks may say more than any single number.
- **Review depth.** Comment counts are a weak proxy for review quality — an LLM read of review *content* would say more, at real cost.
- **What "working on" means for open PRs.** Only merged work is bucketed by landing week; long-lived open PRs are currently visible only in the week they were opened.
- **Cross-person views** (team week, who reviewed whom) have no home in the current navigation.

## Known gaps / fidelity

- **`reviews` is inflated by thread replies**: every inline reply creates its own `COMMENTED` review, so one back-and-forth reads as several reviews. Candidate fix: don't count a body-less `COMMENTED` review as a review (its inline comments already count).
- Pagination caps: first 50 reviews and 50 conversation comments per PR, 50 inline comments per review. None are paginated.
- **`npm test` opens the real `data/git-observer.db`**: `ingest.test.ts` → `ingest.ts` → `db.ts`, which opens the DB (and runs the `INGEST_VERSION` step) on import. Fix: move `shouldSkipRepo` somewhere pure, or make the DB path injectable.
- No commit-level data, so work that never became a PR is invisible.
- `pullRequestsInRange` overlaps `created_at` OR `merged_at` against the window; a PR both opened and merged in one week is fetched once and correctly counted in each list.

## Positioning

- Personal tool first; no external contributor story yet.
- Extension path if that changes: a second forge module behind `server/github.ts`'s shapes.
