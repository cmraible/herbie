import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ApiError,
  createClient,
  type Repository,
  type Run,
  type RunEvent,
} from "@prompt-to-pr/contracts";
import "./style.css";

const api = createClient(location.origin);
const active = (run: Run) => ["queued", "running"].includes(run.status);
const statusLabel = (run: Run) =>
  ({
    queued: "Queued",
    running: "Working",
    succeeded: "Draft PR ready",
    no_changes: "No changes needed",
    failed: "Run failed",
    needs_attention: "Needs attention",
  })[run.status];
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";
function App() {
  const [user, setUser] = useState<{ id: string; login: string } | null>();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [approved, setApproved] = useState(false);
  const device = location.pathname === "/device";

  async function loadRuns() {
    const items: Run[] = [];
    let cursor: string | null = "";
    do {
      const page = await api.runs(cursor);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    setRuns(items);
  }
  async function refreshRepositories() {
    const items: Repository[] = [];
    let cursor: string | null = "";
    do {
      const page = await api.repositories(cursor);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    setRepositories(items);
    setRepositoryId((current) => current || String(items[0]?.id ?? ""));
  }
  async function showRun(id: string) {
    setRun(await api.run(id));
    const items: RunEvent[] = [];
    let after: string | null = "0";
    do {
      const page = await api.events(id, after);
      items.push(...page.items);
      after = page.nextCursor;
    } while (after);
    setEvents(items);
  }
  async function signIn() {
    const result = await api.request<{ url: string }>("/api/auth/sign-in/social", {
      method: "POST",
      body: JSON.stringify({
        provider: "github",
        callbackURL: `${location.origin}${device ? "/device" : "/"}`,
      }),
    });
    location.assign(result.url);
  }
  async function action(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void api
      .me()
      .then(async (user) => {
        setUser(user);
        if (!device) {
          await Promise.all([refreshRepositories(), loadRuns()]);
          const id = new URLSearchParams(location.search).get("run");
          if (id) await showRun(id);
        }
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 401) setUser(null);
        else setError(message(error));
      });
  }, []);
  useEffect(() => {
    if (run?.id)
      document.getElementById("run-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [run?.id]);
  useEffect(() => {
    if (!user || device || (!runs.some(active) && !(run && active(run)))) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await loadRuns();
        if (run) await showRun(run.id);
      } catch (error) {
        if (!disposed) setError(message(error));
      }
      if (!disposed) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [user, runs.some(active), run?.id, run?.status]);

  return (
    <main>
      <header>
        <a className="brand" href="/">
          Prompt to PR
        </a>
        {user && (
          <span>
            @{user.login}{" "}
            <button
              className="quiet"
              onClick={() =>
                void action(async () => {
                  await api.request("/api/auth/sign-out", { method: "POST", body: "{}" });
                  location.assign("/");
                })
              }
            >
              Sign out
            </button>
          </span>
        )}
      </header>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {user === undefined ? (
        <p>Loading…</p>
      ) : !user ? (
        <section className="welcome">
          <p className="eyebrow">ONE TASK. ONE PULL REQUEST.</p>
          <h1>
            A small change starts
            <br />
            with a clear prompt.
          </h1>
          <p>Choose a repository, describe what you need, and review the draft PR.</p>
          <button disabled={busy} onClick={() => void action(signIn)}>
            Sign in with GitHub
          </button>
        </section>
      ) : device ? (
        <section>
          <h1>Connect your CLI</h1>
          {approved ? (
            <p>Done. Return to your terminal.</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  await api.request("/api/auth/device/approve", {
                    method: "POST",
                    body: JSON.stringify({ userCode: code }),
                  });
                  setApproved(true);
                });
              }}
            >
              <p>
                Enter the code from your own terminal. This gives that CLI access to your runs and
                repositories.
              </p>
              <label>
                Terminal code
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                  autoComplete="off"
                />
              </label>
              <div className="actions">
                <button disabled={busy}>Approve CLI</button>
                <button
                  type="button"
                  disabled={busy || !code}
                  className="quiet"
                  onClick={() =>
                    void action(async () => {
                      await api.request("/api/auth/device/deny", {
                        method: "POST",
                        body: JSON.stringify({ userCode: code }),
                      });
                      setApproved(true);
                    })
                  }
                >
                  Deny
                </button>
              </div>
            </form>
          )}
        </section>
      ) : (
        <>
          <section>
            <p className="eyebrow">NEW RUN</p>
            <h1>What should we change?</h1>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  const input = { repositoryId: Number(repositoryId), prompt: prompt.trim() };
                  const signature = JSON.stringify(input);
                  let pending: { signature: string; key: string } | null = null;
                  try {
                    pending = JSON.parse(sessionStorage.getItem("pending-run") ?? "null");
                  } catch {}
                  const key = pending?.signature === signature ? pending.key : crypto.randomUUID();
                  sessionStorage.setItem("pending-run", JSON.stringify({ signature, key }));
                  const created = await api.createRun(input, key);
                  sessionStorage.removeItem("pending-run");
                  history.replaceState(null, "", `/?run=${created.id}`);
                  await showRun(created.id);
                  await loadRuns();
                  setPrompt("");
                });
              }}
            >
              <label>
                Repository
                <select
                  value={repositoryId}
                  onChange={(event) => setRepositoryId(event.target.value)}
                  required
                >
                  <option value="" disabled>
                    Choose a repository
                  </option>
                  {repositories.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.fullName}
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions">
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const result = await api.request<{ url: string }>("/api/v1/installation", {
                        method: "POST",
                        body: "{}",
                      });
                      location.assign(result.url);
                    })
                  }
                >
                  Connect repositories
                </button>
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => void action(refreshRepositories)}
                >
                  Refresh
                </button>
              </div>
              {!repositories.length && (
                <p>Connect the GitHub App to a repository where you have push access.</p>
              )}
              <label>
                Prompt
                <textarea
                  rows={6}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  required
                  maxLength={20000}
                  placeholder="Describe the change and how you'll know it works."
                />
              </label>
              <p className="hint">
                Runs create draft PRs on a new branch. You review and merge in GitHub.
              </p>
              <button disabled={busy || !repositoryId || !prompt.trim()}>
                {busy ? "Working…" : "Create run"}
              </button>
            </form>
          </section>
          {run && (
            <section id="run-detail" aria-live="polite">
              <p className="eyebrow">RUN · {run.repository.fullName}</p>
              <h2>{statusLabel(run)}</h2>
              <p>{run.prompt}</p>
              <p className="hint">
                {run.id} · {run.stage}
              </p>
              {run.pullRequest && (
                <a className="button" href={run.pullRequest.url} target="_blank" rel="noreferrer">
                  Open draft PR ↗
                </a>
              )}
              {run.error && <p className="error">{run.error.message}</p>}
              {run.summary && <p className="summary">{run.summary}</p>}
              <ol className="events">
                {events.map((event) => (
                  <li key={event.id}>{event.message}</li>
                ))}
              </ol>
            </section>
          )}
          <section>
            <h2>Recent runs</h2>
            {runs.length ? (
              <ul className="runs">
                {runs.map((item) => (
                  <li key={item.id}>
                    <button
                      className="run"
                      onClick={() =>
                        void action(async () => {
                          history.replaceState(null, "", `/?run=${item.id}`);
                          await showRun(item.id);
                        })
                      }
                    >
                      <span>
                        <strong>{item.repository.fullName}</strong>
                        <span className="preview">{item.prompt}</span>
                      </span>
                      <span className="badge">{statusLabel(item)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Your first run will appear here.</p>
            )}
          </section>
        </>
      )}
      <footer>Small tasks. Reviewable changes.</footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
