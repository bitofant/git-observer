// ISO-8601 week bucketing, in UTC. Pure — this is the module every count in
// the app is grouped by, so it's the first thing that must be right.
//
// Why UTC and not local time: GitHub timestamps are UTC instants, and the
// server, the browser and any future scheduled job must agree on which week a
// PR landed in. Bucketing in local time makes "last week" mean different things
// on two machines, and shifts a Sunday-evening merge across the boundary
// depending on who is looking. One rule, applied everywhere.

import type { WeekId } from "./protocol.js";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Midnight UTC on the Monday of the ISO week containing `ms`. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const utcMidnight = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
  );
  // getUTCDay: 0=Sun..6=Sat. ISO weeks start Monday, so Sunday is day 7.
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return utcMidnight - (isoDay - 1) * DAY_MS;
}

/** The ISO week id ("2026-W37") containing `ms`. */
export function weekIdOf(ms: number): WeekId {
  const monday = weekStart(ms);
  // ISO rule: a week belongs to the year containing its Thursday. Deriving the
  // year from the Monday instead is the classic off-by-one at New Year.
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstMonday = weekStart(firstThursday.getTime());
  const week = Math.round((monday - firstMonday) / WEEK_MS) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Inclusive-exclusive UTC bounds [start, end) of a week id. */
export function weekBounds(week: WeekId): { start: number; end: number } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`bad week id: ${week}`);
  const year = Number(m[1]);
  const n = Number(m[2]);
  const firstMonday = weekStart(Date.UTC(year, 0, 4));
  const start = firstMonday + (n - 1) * WEEK_MS;
  return { start, end: start + WEEK_MS };
}

/** Step a week id by `delta` weeks (negative goes back). */
export function shiftWeek(week: WeekId, delta: number): WeekId {
  return weekIdOf(weekBounds(week).start + delta * WEEK_MS);
}

/** Every week id from `from` to `to` inclusive, newest first. Used to build the
 * week picker without a DISTINCT over the whole table. */
export function weeksBetween(from: WeekId, to: WeekId): WeekId[] {
  const a = weekBounds(from).start;
  const b = weekBounds(to).start;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const out: WeekId[] = [];
  for (let t = hi; t >= lo; t -= WEEK_MS) out.push(weekIdOf(t));
  return out;
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const DAYS = "Sun Mon Tue Wed Thu Fri Sat".split(" ");

/** "Mon 7 Sep – Sun 13 Sep 2026", for the dashboard header.
 *
 * Formatted by hand rather than with `toLocaleDateString`: Intl output varies
 * by Node's ICU build (one gives "Sep", another "Sept", and it injects a comma
 * once a year is present), which makes the header wobble between environments
 * and the test unpinnable. A week range is four fixed tokens — not worth a
 * locale dependency. */
export function formatWeekRange(week: WeekId): string {
  const { start, end } = weekBounds(week);
  const first = new Date(start);
  const last = new Date(end - DAY_MS);
  const part = (d: Date) =>
    `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return `${part(first)} – ${part(last)} ${last.getUTCFullYear()}`;
}
