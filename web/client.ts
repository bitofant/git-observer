import type {
  Person,
  Status,
  WeeklyReport,
  WeekSummary,
} from "../shared/protocol.js";

// REST only — there is no WebSocket. Nothing here streams: the data changes
// when a background sync lands, on the order of minutes, so polling a cached
// snapshot is the honest shape (and one less moving part than a socket).

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const getStatus = () => json<Status>("/api/status");

export const getPeople = () => json<Person[]>("/api/people");

export const addPerson = (login: string, displayName: string) =>
  json<Person>("/api/people", {
    method: "POST",
    body: JSON.stringify({ login, displayName }),
  });

export const removePerson = (login: string) =>
  json<{ ok: true }>(`/api/people/${encodeURIComponent(login)}`, {
    method: "DELETE",
  });

export const getWeeks = (login: string) =>
  json<WeekSummary[]>(`/api/people/${encodeURIComponent(login)}/weeks`);

export const getReport = (login: string, week?: string) =>
  json<WeeklyReport>(
    `/api/people/${encodeURIComponent(login)}/week` +
      (week ? `?week=${encodeURIComponent(week)}` : ""),
  );

export const triggerSync = () =>
  json<{ started: boolean }>("/api/sync", { method: "POST" });
