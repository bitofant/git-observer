# git-observer

A per-developer dashboard over GitHub activity, with LLM-classified pull requests.

`git-observer` is a single webpage listing the people you want to keep an eye
on. Click one and you get their week: what they shipped, how substantial it was,
and how much they helped review everyone else's work.

> **Status:** early development. Interfaces and scope are still moving.

## Why

Counting PRs tells you almost nothing — a dependency bump and an authentication
rewrite both count as one. `git-observer` runs each pull request past an LLM to
get two things a raw count can't give you:

- a **size** (`trivial` / `small` / `medium` / `large`) that reflects how much
  engineering thought the change represents, *not* how many lines it touched, and
- a **one-sentence summary** of what it does, at a level you can skim.

Aggregated by week, that turns "17 PRs" into something you can actually read:
what someone worked on last week, how many of those were substantial, and
whether they were engaged in reviewing others.

## How it works

```
GitHub  ──gh CLI──▶  ingest  ──▶  SQLite  ──▶  LLM classification
                                     │
                                     ▼
                            weekly rollup (derived)
                                     │
                       HTTP + JSON   ▼
                            Browser (React)
```

- All GitHub access goes through the **`gh` CLI**, which brings its own auth —
  so there is no token to manage in config.
- A background **sync** walks each tracked repo's pull requests incrementally
  and caches them in SQLite, along with reviews, conversation comments and
  inline code comments.
- A **classification pass** shows each new PR's title, description, file list
  and diffstat to an OpenAI-compatible LLM endpoint, and stores the size and
  summary it returns. Results are cached by content hash, so a PR is never
  classified twice.
- **Weekly numbers are derived on read**, never stored — a PR merged late or a
  re-classification retroactively changes a past week, and a cached rollup has
  no way to know.

## Features

- **People-first navigation** — add anyone by GitHub login; each gets their own
  dashboard.
- **Weekly view** — merged and opened PRs, a size histogram, and the diffstat
  for the week, with arrow/dropdown navigation across weeks.
- **Review activity** — reviews, code comments and conversation comments left
  on *other people's* PRs, with
  distinct PRs touched and people helped, so volume on a single thread doesn't
  masquerade as breadth.
- **Degrades honestly** — with no LLM endpoint you still get counts, diffstats
  and review activity; unclassified PRs are shown as unclassified rather than
  guessed at or hidden.

## Getting started

```bash
npm install
gh auth login        # if you haven't already
./config-gen.sh      # generates config.json (gitignored)
npm run sync         # first backfill — can take a while
npm run dev          # single-port dev server with hot reload
```

Then open the printed local URL (default <http://localhost:4100>) and add a
person from the main menu.

For a production run:

```bash
npm run build        # builds the frontend into dist/web
npm start            # serves UI + API on one port
./install-service.sh # or: run it as a systemd user service
```

**Requirements:** Node.js and an authenticated [`gh`](https://cli.github.com/)
on your `PATH`. An OpenAI-compatible LLM endpoint (a local vLLM or llama.cpp
works fine) is optional but is what produces the sizes and summaries.

## Security

There is **no authentication**, by design. The server binds to loopback
(`127.0.0.1`) and is meant to be reached over an SSH tunnel or behind a reverse
proxy that authenticates for it. Don't widen the bind address without putting
something in front of it — these dashboards name real people and their work.

## License

[MIT](./LICENSE) © Jöran Tesse
