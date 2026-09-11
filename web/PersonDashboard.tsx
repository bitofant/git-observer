import { useEffect, useState } from "react";
import type {
  Person,
  PrSize,
  PrWithInsight,
  WeeklyReport,
  WeekSummary,
} from "../shared/protocol";
import { formatWeekRange, shiftWeek, weekIdOf } from "../shared/week";
import * as api from "./client";

// The per-person dashboard. Deliberately a thin renderer: every number comes
// from the server's WeeklyReport (server/rollup.ts), so there is exactly one
// definition of "merged this week" and the UI can't drift from it.
//
// The layout below is a first pass — which panels earn their place is still an
// open question (see CLAUDE.md "Dashboard — open questions").

const SIZE_ORDER: PrSize[] = ["large", "medium", "small", "trivial"];

function SizeBar({ sizes }: { sizes: WeeklyReport["authored"]["sizes"] }) {
  const total = SIZE_ORDER.reduce((n, s) => n + sizes[s], 0) + sizes.unknown;
  if (total === 0) return null;
  return (
    <div className="size-bar" title="Merged PRs by size">
      {SIZE_ORDER.map((size) =>
        sizes[size] > 0 ? (
          <span
            key={size}
            className={`size-seg ${size}`}
            style={{ flexGrow: sizes[size] }}
          >
            {sizes[size]}
          </span>
        ) : null,
      )}
      {/* Unclassified work is shown, never hidden or folded into a size —
          otherwise a missing LLM silently shrinks someone's week. */}
      {sizes.unknown > 0 && (
        <span
          className="size-seg unknown"
          style={{ flexGrow: sizes.unknown }}
          title="Not classified"
        >
          {sizes.unknown}
        </span>
      )}
    </div>
  );
}

function PrRow({ pr }: { pr: PrWithInsight }) {
  return (
    <li className="pr-row">
      <div className="pr-head">
        {pr.insight && <span className={`size-tag ${pr.insight.size}`}>{pr.insight.size}</span>}
        <a href={pr.url} target="_blank" rel="noreferrer" className="pr-title">
          {pr.title}
        </a>
        <span className="pr-meta">
          {pr.repo} #{pr.number}
        </span>
      </div>
      {/* The one-sentence summary is the point of the classification pass:
          it's what makes a week's list skimmable without opening each PR. */}
      {pr.insight ? (
        <div className="pr-summary">{pr.insight.summary}</div>
      ) : (
        <div className="pr-summary muted">not classified</div>
      )}
      <div className="pr-stat">
        <span className="add">+{pr.additions}</span>{" "}
        <span className="del">−{pr.deletions}</span> · {pr.changedFiles} files
      </div>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function PersonDashboard({
  person,
  onBack,
}: {
  person: Person;
  onBack: () => void;
}) {
  const [week, setWeek] = useState(() => weekIdOf(Date.now()));
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getWeeks(person.login).then(setWeeks).catch(() => setWeeks([]));
  }, [person.login]);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    api
      .getReport(person.login, week)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [person.login, week]);

  const active = weeks.find((w) => w.week === week);

  return (
    <div className="dashboard">
      <header className="dash-head">
        <button className="back" onClick={onBack} title="Back to everyone">
          ←
        </button>
        <div className="dash-title">
          <h1>{person.displayName}</h1>
          <span className="person-login">@{person.login}</span>
        </div>
      </header>

      <div className="week-nav">
        <button onClick={() => setWeek((w) => shiftWeek(w, -1))}>‹</button>
        <div className="week-label">
          <strong>{week}</strong>
          <span className="muted">{formatWeekRange(week)}</span>
        </div>
        <button
          onClick={() => setWeek((w) => shiftWeek(w, 1))}
          // Nothing has happened in the future; stepping there is only confusing.
          disabled={week >= weekIdOf(Date.now())}
        >
          ›
        </button>
        <select value={week} onChange={(e) => setWeek(e.target.value)}>
          {(weeks.some((w) => w.week === week)
            ? weeks
            : [{ week, merged: 0, opened: 0, reviews: 0 }, ...weeks]
          ).map((w) => (
            <option key={w.week} value={w.week}>
              {w.week} — {w.merged} merged, {w.reviews} reviews
            </option>
          ))}
        </select>
      </div>

      {error && <div className="form-error">{error}</div>}
      {!report && !error && <div className="loading">Loading…</div>}

      {report && (
        <div className="cards">
          <section className="card">
            <h2>This week</h2>
            <div className="stats">
              <Stat label="PRs merged" value={report.authored.merged.length} />
              <Stat label="PRs opened" value={report.authored.opened.length} />
              <Stat
                label="bigger PRs"
                value={
                  report.authored.sizes.large + report.authored.sizes.medium
                }
              />
              <Stat
                label="lines"
                value={`+${report.authored.additions} −${report.authored.deletions}`}
              />
            </div>
            <SizeBar sizes={report.authored.sizes} />
            {active && active.merged === 0 && active.opened === 0 && (
              <p className="empty">No authored activity this week.</p>
            )}
          </section>

          <section className="card">
            <h2>Review of others</h2>
            <div className="stats">
              <Stat label="reviews" value={report.reviewing.reviews} />
              <Stat label="comments" value={report.reviewing.comments} />
              <Stat label="PRs touched" value={report.reviewing.prsTouched} />
              <Stat label="people helped" value={report.reviewing.authorsHelped} />
            </div>
          </section>

          <section className="card wide">
            <h2>Merged ({report.authored.merged.length})</h2>
            {report.authored.merged.length === 0 ? (
              <p className="empty">Nothing merged this week.</p>
            ) : (
              <ul className="pr-list">
                {report.authored.merged.map((pr) => (
                  <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
                ))}
              </ul>
            )}
          </section>

          <section className="card wide">
            <h2>Opened ({report.authored.opened.length})</h2>
            {report.authored.opened.length === 0 ? (
              <p className="empty">Nothing opened this week.</p>
            ) : (
              <ul className="pr-list">
                {report.authored.opened.map((pr) => (
                  <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
