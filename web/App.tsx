import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useState,
} from "react";
import type { Person, Status } from "../shared/protocol";
import * as api from "./client";

const PersonDashboard = lazy(() =>
  import("./PersonDashboard").then((m) => ({ default: m.PersonDashboard })),
);

/** Which person is open lives in the URL hash, so a reload and a shared link
 * both land on the same dashboard without any router dependency. */
function useSelectedLogin(): [string | null, (login: string | null) => void] {
  const read = () => decodeURIComponent(location.hash.replace(/^#/, "")) || null;
  const [login, setLogin] = useState<string | null>(read);
  useEffect(() => {
    const onHash = () => setLogin(read());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const select = useCallback((next: string | null) => {
    location.hash = next ? encodeURIComponent(next) : "";
    setLogin(next);
  }, []);
  return [login, select];
}

function AddPersonForm({ onAdded }: { onAdded: (p: Person) => void }) {
  const [login, setLogin] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!login.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onAdded(await api.addPerson(login.trim(), name.trim()));
      setLogin("");
      setName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-form" onSubmit={submit}>
      <input
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        placeholder="GitHub login"
        aria-label="GitHub login"
        autoFocus
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Display name (optional)"
        aria-label="Display name"
      />
      <button type="submit" className="primary" disabled={!login.trim() || busy}>
        Add
      </button>
      {error && <div className="form-error">{error}</div>}
    </form>
  );
}

function StatusBar({ status }: { status: Status | null }) {
  if (!status) return null;
  const { github, llm, sync } = status;
  return (
    <div className="status-bar">
      <span className={github.available ? "chip ok" : "chip bad"}>
        GitHub {github.available ? `· ${github.repos.length} repos` : "unavailable"}
      </span>
      {/* The LLM is optional: without it the app still shows counts and
          diffstats, just no sizes or summaries. Say so rather than looking broken. */}
      <span className={llm.available ? "chip ok" : "chip idle"}>
        {llm.available ? `LLM · ${llm.model}` : "LLM offline — no PR insights"}
      </span>
      {sync.pendingInsights > 0 && (
        <span className="chip idle">{sync.pendingInsights} PRs to classify</span>
      )}
      {sync.running && <span className="chip idle">syncing…</span>}
      {!github.available && github.detail && (
        <span className="status-detail">{github.detail}</span>
      )}
    </div>
  );
}

function PeopleMenu({
  people,
  status,
  onSelect,
  onAdded,
  onRemoved,
}: {
  people: Person[];
  status: Status | null;
  onSelect: (login: string) => void;
  onAdded: (p: Person) => void;
  onRemoved: (login: string) => void;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="menu">
      <header className="menu-head">
        <h1>git-observer</h1>
        <button onClick={() => setAdding((v) => !v)} className="primary">
          {adding ? "Cancel" : "+ Add"}
        </button>
      </header>

      <StatusBar status={status} />

      {adding && (
        <AddPersonForm
          onAdded={(p) => {
            onAdded(p);
            setAdding(false);
          }}
        />
      )}

      {people.length === 0 && !adding ? (
        <p className="empty">
          No one tracked yet. Add a GitHub login to see their weekly activity.
        </p>
      ) : (
        <ul className="people">
          {people.map((p) => (
            <li key={p.login}>
              <button className="person-row" onClick={() => onSelect(p.login)}>
                <span className="person-name">{p.displayName}</span>
                <span className="person-login">@{p.login}</span>
              </button>
              <button
                className="person-remove"
                title={`Stop tracking ${p.displayName}`}
                onClick={() => {
                  void api.removePerson(p.login).then(() => onRemoved(p.login));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function App() {
  const [people, setPeople] = useState<Person[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [login, setLogin] = useSelectedLogin();

  useEffect(() => {
    void api.getPeople().then(setPeople).catch(() => setPeople([]));
  }, []);

  useEffect(() => {
    // Poll rather than push: sync results land minutes apart, and skipping
    // while hidden keeps a forgotten background tab free.
    const tick = () => {
      if (!document.hidden) void api.getStatus().then(setStatus).catch(() => {});
    };
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, []);

  const person = people.find((p) => p.login.toLowerCase() === login?.toLowerCase());

  return (
    <div className="app">
      {login && person ? (
        <Suspense fallback={<div className="loading">Loading…</div>}>
          <PersonDashboard person={person} onBack={() => setLogin(null)} />
        </Suspense>
      ) : (
        <PeopleMenu
          people={people}
          status={status}
          onSelect={setLogin}
          onAdded={(p) =>
            setPeople((prev) =>
              [...prev.filter((x) => x.login !== p.login), p].sort((a, b) =>
                a.displayName.localeCompare(b.displayName),
              ),
            )
          }
          onRemoved={(gone) =>
            setPeople((prev) => prev.filter((p) => p.login !== gone))
          }
        />
      )}
    </div>
  );
}
