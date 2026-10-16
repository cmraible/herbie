import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient, ApiError } from "@herbie/contracts/client";
import {
  githubPermissionsMessage,
  streamMessageSchema,
  type Project,
  type ProjectEvent,
  type ProjectAction,
  type Repository,
  type Session,
} from "@herbie/contracts";
import { draftSchema, newDraft, parseDraft, type Draft } from "./draft.js";

import { sortRepositories } from "./repositories.js";
import { AttemptHistory } from "./AttemptHistory.js";
import { errorReference, projectErrorMessage, workflowPermissionMessage } from "./activity-message.js";
import { RepositorySelect } from "./RepositorySelect.js";
import { projectReadyForReview } from "./attempts.js";

const api = createClient();
const terminal = new Set(["completed", "cancelled", "failed"]);
const onboardingInstallKey = "herbie-onboarding-install";
const labels: Record<Project["state"], string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  awaiting_review: "Ready for review",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  needs_attention: "Needs attention",
};
function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please retry.";
}
function time(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function initialDraft() {
  try {
    return draftSchema.parse(JSON.parse(sessionStorage.getItem("herbie-draft") ?? "null"));
  } catch {
    return newDraft();
  }
}
function Badge({ project }: { project: Project }) {
  const waitingForChecks = project.state === "awaiting_review" && !projectReadyForReview(project);
  return (
    <span className={`badge status-${waitingForChecks ? "waiting_for_checks" : project.state}`}>
      {waitingForChecks ? "Waiting for checks" : labels[project.state]}
    </span>
  );
}

export function App() {
  const [revision, setRevision] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionState, setSessionState] = useState<
    "pending" | "signed-in" | "signed-out" | "error"
  >("pending");
  const [healthState, setHealthState] = useState<"pending" | "ready" | "error">("pending");
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupRefresh, setStartupRefresh] = useState(0);
  const streamRevision = useRef(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsRefresh, setProjectsRefresh] = useState(0);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [permissionsRequired, setPermissionsRequired] = useState(false);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [repositoryLoading, setRepositoryLoading] = useState(true);
  const [repositoriesResolved, setRepositoriesResolved] = useState(false);
  const [repositoryRefresh, setRepositoryRefresh] = useState(0);
  const [screen, setScreen] = useState<string | null>(() => location.hash.slice(1) || null);
  const [showFinished, setShowFinished] = useState(false);
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [eventsState, setEventsState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectEdit, setProjectEdit] = useState<(Draft & { id: string }) | null>(null);
  const creating = screen === "new";
  const editing = Boolean(screen?.endsWith("/edit"));
  const [projectScreen, selectedRun = null] = (screen ?? "").split("/runs/");
  const selected = creating ? null : editing ? screen!.slice(0, -5) : projectScreen || null;
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [formError, setFormError] = useState<string | null>(null);
  const [installationNotice, setInstallationNotice] = useState<string | null>(null);
  const project = projects.find((item) => item.id === selected) ?? null;
  const workflowPermissionError = workflowPermissionMessage(project?.error ?? "");
  const formDraft = editing ? projectEdit : draft;
  useEffect(() => {
    setFormError(null);
    if (!editing) setProjectEdit(null);
  }, [screen]);
  useEffect(() => {
    if (editing && project?.state === "cancelled") {
      navigateToScreen(project.id, true);
      return;
    }
    if (editing && project)
      setProjectEdit((current) =>
        current?.id === project.id
          ? current
          : {
              ...newDraft(project.repository),
              id: project.id,
              name: project.name,
              prompt: project.prompt,
              maxWip: String(project.maxWip),
            },
      );
  }, [editing, project]);
  const visibleProjects = projects.filter(
    (item) => showFinished || !["completed", "cancelled"].includes(item.state),
  );
  const finishedCount = projects.filter((item) =>
    ["completed", "cancelled"].includes(item.state),
  ).length;

  useEffect(() => {
    let alive = true;
    async function initialize() {
      setStartupError(null);
      setHealthState("pending");
      setSessionState("pending");
      const healthRequest = api
        .health()
        .then((health) => {
          if (!alive) return;
          setHealthState("ready");
          setRevision(
            [health.deploymentId, health.imageRevision].find(
              (value) => value && /^[a-f0-9]{40}$/i.test(value),
            ) ?? null,
          );
        })
        .catch((failure) => {
          if (!alive) return;
          setHealthState("error");
          setStartupError(message(failure));
        });
      const sessionRequest = api
        .session()
        .then((current) => {
          if (!alive) return;
          setSession(current);
          setSessionState("signed-in");
        })
        .catch((failure) => {
          if (!alive) return;
          if (failure instanceof ApiError && failure.status === 401) {
            setSession(null);
            setSessionState("signed-out");
          } else {
            setSessionState("error");
            setStartupError(message(failure));
          }
        });
      await Promise.all([healthRequest, sessionRequest]);
    }
    void initialize();
    return () => {
      alive = false;
    };
  }, [startupRefresh]);

  useEffect(() => {
    const result = new URL(location.href).searchParams.get("installation");
    if (result) setInstallationNotice(result);
    if (result) history.replaceState(null, "", location.pathname + location.hash);
  }, []);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    setProjectsError(null);
    async function refresh() {
      try {
        const revision = streamRevision.current;
        const list = await api.projects();
        if (!alive) return;
        if (revision === streamRevision.current) setProjects(list);
        setProjectsLoaded(true);
        setProjectsError(null);
      } catch (failure) {
        if (!alive) return;
        if (failure instanceof ApiError && failure.status === 401) {
          setSession(null);
          setSessionState("signed-out");
        }
        setProjectsError(message(failure));
      }
    }
    void refresh();

    return () => {
      alive = false;
    };
  }, [session, projectsRefresh]);

  // Repository discovery can require GitHub API calls. Refresh on sign-in or an
  // explicit request, independently from the live project stream.
  useEffect(() => {
    if (!session) {
      setRepositories([]);
      setRepositoryError(null);
      setRepositoryLoading(false);
      setRepositoriesResolved(false);
      return;
    }
    let alive = true;
    setRepositoryLoading(true);
    setRepositoriesResolved(false);
    setRepositoryError(null);
    async function discover() {
      try {
        const discovery = await api.discoverRepositories();
        const list = sortRepositories(discovery.repositories);
        if (!alive) return;
        setPermissionsRequired(discovery.permissionsRequired);
        setInstallationNotice((current) => (current === "permissions" ? null : current));
        setRepositories(list);
        setRepositoriesResolved(true);
        setDraft((current) =>
          list.some((repository) => repository.fullName === current.repository)
            ? current
            : {
                ...current,
                name: undefined,
                repository: list[0]?.fullName ?? "",
                requestId: crypto.randomUUID(),
              },
        );
        if (sessionStorage.getItem(onboardingInstallKey)) {
          sessionStorage.removeItem(onboardingInstallKey);
          if (list.length === 0) void connectRepositories();
        }
      } catch (failure) {
        if (alive) {
          if (failure instanceof ApiError && failure.code === "github_permissions_required") {
            setPermissionsRequired(true);
            setRepositories([]);
          } else setRepositoryError(message(failure));
          setRepositoriesResolved(true);
        }
      } finally {
        if (alive) setRepositoryLoading(false);
      }
    }
    void discover();
    return () => {
      alive = false;
    };
  }, [session, repositoryRefresh]);

  useEffect(() => {
    const restoreRepositories = (event: PageTransitionEvent) => {
      if (
        event.persisted ||
        performance
          .getEntriesByType("navigation")
          .some((entry) => (entry as PerformanceNavigationTiming).type === "back_forward")
      ) {
        setBusy(false);
        setRepositoryRefresh((current) => current + 1);
      }
    };
    const refreshPermissions = () => setRepositoryRefresh((current) => current + 1);
    window.addEventListener("focus", refreshPermissions);
    window.addEventListener("pageshow", restoreRepositories);
    return () => {
      window.removeEventListener("focus", refreshPermissions);
      window.removeEventListener("pageshow", restoreRepositories);
    };
  }, [session]);

  useEffect(() => {
    const restoreScreen = () => setScreen(location.hash.slice(1) || null);
    window.addEventListener("popstate", restoreScreen);
    window.addEventListener("hashchange", restoreScreen);
    return () => {
      window.removeEventListener("popstate", restoreScreen);
      window.removeEventListener("hashchange", restoreScreen);
    };
  }, []);

  useEffect(() => {
    setEvents([]);
    if (!selected || !session) return;
    let alive = true;
    let cursor = 0;
    setEvents([]);
    setEventsError(null);
    setEventsState("loading");
    async function refresh() {
      try {
        const list = await api.events(selected ?? "", cursor);
        if (alive) {
          setEventsState("loaded");
          setEventsError(null);
        }
        if (alive && list.length > 0) {
          cursor = Math.max(cursor, ...list.map((event) => event.id));
          setEvents((current) =>
            [
              ...current,
              ...list.filter((event) => !current.some((existing) => existing.id === event.id)),
            ].sort((a, b) => a.id - b.id),
          );
        }
      } catch (failure) {
        if (alive) {
          setEventsState("error");
          setEventsError(message(failure));
        }
      }
    }
    void refresh();

    return () => {
      alive = false;
    };
  }, [selected, session]);

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 500;
    function connect() {
      const url = new URL("/api/stream", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      if (selected) url.searchParams.set("project", selected);
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const update = streamMessageSchema.parse(JSON.parse(event.data));
          delay = 500;
          setReconnecting(false);
          if (update.type === "projects") {
            streamRevision.current++;
            setProjects(update.projects);
            setProjectsLoaded(true);
            setProjectsError(null);
          } else if (update.projectId === selected) {
            setEvents((current) =>
              [
                ...new Map([...current, ...update.events].map((item) => [item.id, item])).values(),
              ].sort((a, b) => a.id - b.id),
            );
            setEventsState("loaded");
            setEventsError(null);
          }
        } catch {
          socket.close();
        }
      };
      socket.onclose = async (event) => {
        if (disposed) return;
        if (event.code === 1008) {
          setSession(null);
          setSessionState("signed-out");
          return;
        }
        setReconnecting(true);
        // Browsers hide HTTP 401 upgrade responses behind close code 1006.
        try {
          await api.session();
        } catch (failure) {
          if (disposed) return;
          if (failure instanceof ApiError && failure.status === 401) {
            setSession(null);
            setSessionState("signed-out");
            return;
          }
        }
        if (disposed) return;
        timer = setTimeout(connect, delay + (Math.random() * delay) / 2);
        delay = Math.min(delay * 2, 30_000);
      };
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket.close();
    };
  }, [session, selected]);

  function navigateToScreen(id: string, replace = false) {
    if (replace) history.replaceState(null, "", `#${id}`);
    else history.pushState(null, "", `#${id}`);
    setScreen(id);
  }
  function navigateToList() {
    if (creating) history.replaceState(null, "", location.pathname + location.search);
    else history.pushState(null, "", location.pathname + location.search);
    setScreen(null);
  }

  useEffect(() => {
    sessionStorage.setItem("herbie-draft", JSON.stringify(draft));
  }, [draft]);

  async function login() {
    setBusy(true);
    setError(null);
    try {
      sessionStorage.setItem(onboardingInstallKey, "1");
      const auth = await api.authStart("web");
      location.assign(auth.url);
    } catch (failure) {
      sessionStorage.removeItem(onboardingInstallKey);
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }
  async function connectRepositories() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.installationStart();
      location.assign(result.url);
    } catch (failure) {
      setError(message(failure));
      setBusy(false);
    }
  }
  function edit(change: Partial<Draft>) {
    setDraft((current) => ({
      ...current,
      ...change,
      name: undefined,
      requestId: crypto.randomUUID(),
    }));
    setFormError(null);
  }
  function openCreate() {
    if (!session || sessionState !== "signed-in" || !projectsLoaded) return;
    if (!draft.repository && repositories[0])
      setDraft((current) => ({
        ...current,
        name: undefined,
        repository: repositories[0].fullName,
        requestId: crypto.randomUUID(),
      }));
    navigateToScreen("new");
    setFormError(null);
  }
  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const result = await api.start(parseDraft(draft), draft.requestId);
      setProjects((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      setProjectsLoaded(true);
      if (location.hash === "#new") navigateToScreen(result.id, true);
      setDraft(newDraft(draft.repository));
    } catch (failure) {
      setFormError(message(failure));
    } finally {
      setBusy(false);
    }
  }
  async function saveProjectEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectEdit || project?.state === "cancelled") return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await api.update(projectEdit.id, {
        name: projectEdit.name,
        prompt: projectEdit.prompt,
        maxWip: Number(projectEdit.maxWip),
      });
      setProjects((current) => current.map((item) => (item.id === result.id ? result : item)));
      if (location.hash === `#${projectEdit.id}/edit`) navigateToScreen(result.id, true);
    } catch (failure) {
      setFormError(message(failure));
    } finally {
      setBusy(false);
    }
  }
  function editForm(change: Partial<Draft>) {
    if (editing) {
      setProjectEdit((current) => (current ? { ...current, ...change } : current));
      setFormError(null);
    } else edit(change);
  }
  async function control(action: ProjectAction | "retry" | "retry-repair", repairId?: string) {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        action === "retry-repair"
          ? await api.retryRepair(project.id, repairId!)
          : action === "retry"
            ? workflowPermissionError
              ? await api.retryPublication(project.id)
              : await api.retry(project.id)
            : await api.action(project.id, action);
      setProjects((current) => current.map((item) => (item.id === result.id ? result : item)));
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      {sessionState === "signed-in" && (
        <header className="app-header">
          <a className="wordmark" href="#" aria-label="Herbie home">
            Herbie<span aria-hidden="true">.</span>
          </a>
          <span>Coding workspace</span>
        </header>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      <main className={`workspace${creating || editing ? " workspace-create" : ""}`}>
        {sessionState !== "signed-in" ? (
          <section className="welcome" aria-busy={sessionState === "pending"}>
            <h1>Herbie</h1>
            <p>
              Give a project a clear brief. Herbie works on it and brings back patches for you to
              review.
            </p>
            {sessionState === "pending" && <p role="status">Checking your workspace…</p>}
            {(sessionState === "error" || healthState === "error") && (
              <div className="status-message" role="alert">
                {startupError ?? "Herbie could not connect."}
                <button onClick={() => setStartupRefresh((value) => value + 1)}>Try again</button>
              </div>
            )}
            {sessionState === "signed-out" && healthState === "ready" && (
              <>
                <button
                  className="primary"
                  onClick={() => {
                    void login();
                  }}
                  disabled={busy}
                >
                  Continue with GitHub
                </button>
                <p className="fineprint">
                  GitHub access is checked separately for each repository.
                </p>
              </>
            )}
          </section>
        ) : (
          <>
            {creating && (
              <button className="back-button" onClick={navigateToList} disabled={busy}>
                ← Back to projects
              </button>
            )}
            {editing && (
              <button
                className="back-button"
                disabled={busy}
                onClick={() => navigateToScreen(selected!, true)}
              >
                ← Back to project
              </button>
            )}
            <section className="page-heading">
              <div>
                {selected && !creating && !editing ? (
                  <nav className="breadcrumbs" aria-label="Breadcrumb">
                    <button className="back-button" onClick={navigateToList}>
                      All projects
                    </button>
                    {project && (
                      <>
                        <span aria-hidden="true">&gt;</span>
                        {selectedRun ? (
                          <>
                            <a href={`#${project.id}`}>{project.name}</a>
                            <span aria-hidden="true">&gt;</span>
                            <span aria-current="page">Run details</span>
                          </>
                        ) : (
                          <span aria-current="page">{project.repository}</span>
                        )}
                      </>
                    )}
                  </nav>
                ) : (
                  <h1>{creating ? "New project" : editing ? "Edit project" : "Projects"}</h1>
                )}
                {!creating && !selected && (
                  <p>Track progress, review results, and decide what’s next.</p>
                )}
              </div>
              {!creating && !editing && !selected && (
                <div className="heading-actions">
                  <button className="primary" onClick={openCreate} disabled={busy || !projectsLoaded}>
                    New project
                  </button>
                </div>
              )}
            </section>
            {(permissionsRequired || installationNotice === "permissions") && (
              <div className="status-message" role="alert">
                <span>
                  {githubPermissionsMessage}. Approve the updated permissions on GitHub to continue.
                </span>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    void connectRepositories();
                  }}
                >
                  Update GitHub permissions
                </button>
                <button
                  disabled={repositoryLoading}
                  onClick={() => setRepositoryRefresh((current) => current + 1)}
                >
                  Check again
                </button>
              </div>
            )}
            {installationNotice && installationNotice !== "permissions" && (
              <div className="status-message" role="status">
                {{
                  connected: "GitHub connected. Repositories are refreshing.",
                  cancelled: "GitHub connection was cancelled.",
                  expired: "That installation link expired. Connect repositories again.",
                  failed: "Herbie could not verify the installation. Try connecting again.",
                }[installationNotice] ?? "GitHub installation status updated."}
              </div>
            )}
            {healthState === "error" && (
              <div className="status-message" role="alert">
                {startupError ?? "Herbie could not connect."}
                <button onClick={() => setStartupRefresh((value) => value + 1)}>Retry</button>
              </div>
            )}
            {reconnecting && (
              <p className="subtle-note" role="status">
                Reconnecting to live updates. Displayed progress may be out of date.
              </p>
            )}
            {!projectsLoaded && !projectsError && (
              <p className="subtle-note" role="status">
                Loading projects…
              </p>
            )}
            {projectsError && (
              <div className="status-message" role="alert">
                {projectsLoaded && "Couldn’t refresh projects. Showing the latest saved progress. "}
                {projectsError}
                <button onClick={() => setProjectsRefresh((value) => value + 1)}>Retry</button>
              </div>
            )}
            {!creating && !editing && (
              <>
                {!selected && projectsLoaded && projects.length === 0 && (
                  <section className="empty-state">
                    <h2>No projects yet</h2>
                    <p>Start with one useful change.</p>
                    <button className="text-button" onClick={openCreate}>
                      Create a project
                    </button>
                  </section>
                )}
                {!selected && projects.length > 0 && (
                  <>
                    <dl className="project-summary" aria-label="Project overview">
                      <div>
                        <dt>In progress</dt>
                        <dd>
                          {
                            projects.filter((item) => ["queued", "running"].includes(item.state))
                              .length
                          }
                        </dd>
                      </div>
                      <div className="status-awaiting_review">
                        <dt>Ready for review</dt>
                        <dd>{projects.filter(projectReadyForReview).length}</dd>
                      </div>
                      <div className="status-needs_attention">
                        <dt>Needs attention</dt>
                        <dd>
                          {
                            projects.filter((item) =>
                              ["failed", "needs_attention"].includes(item.state),
                            ).length
                          }
                        </dd>
                      </div>
                    </dl>
                    <section className="project-list" aria-label="Projects" aria-busy={!projectsLoaded}>
                      {visibleProjects.map((item) => (
                        <button
                          className="project-row"
                          key={item.id}
                          onClick={() => navigateToScreen(item.id)}
                        >
                          <span className="project-row-heading">
                            <span className="project-row-title">{item.name}</span>
                            <Badge project={item} />
                          </span>
                          <span className="project-row-meta">
                            {item.repository} <span>·</span> {item.attemptCount}{" "}
                            {item.attemptCount === 1 ? "run" : "runs"} <span>·</span> Updated{" "}
                            {time(item.updatedAt)}
                          </span>
                        </button>
                      ))}
                    </section>
                    {finishedCount > 0 && (
                      <button
                        className="finished-toggle"
                        aria-expanded={showFinished}
                        onClick={() => setShowFinished((value) => !value)}
                      >
                        {showFinished ? "Hide" : "Show"} completed and cancelled ({finishedCount})
                      </button>
                    )}
                    {projectsLoaded && visibleProjects.length === 0 && (
                      <section className="empty-state">
                        <h2>All projects are finished</h2>
                        <p>Completed and cancelled projects are hidden.</p>
                      </section>
                    )}
                  </>
                )}
                {selected && project && !selectedRun && (
                  <section
                    className="project-detail"
                    aria-label="Selected project"
                    aria-busy={eventsState === "loading"}
                  >
                    <div className="detail-heading">
                      <div>
                        <Badge project={project} />
                        <h2>{project.name}</h2>
                      </div>
                      {project.state !== "cancelled" && (
                        <>
                          <button
                            className="project-actions-trigger"
                            popoverTarget="project-actions"
                            aria-label="Project actions"
                          >
                            <span aria-hidden="true">⋯</span>
                          </button>
                          <div
                            id="project-actions"
                            popover="auto"
                            className="project-actions-menu"
                            onClick={(event) => {
                              if ((event.target as HTMLElement).closest("button"))
                                event.currentTarget.hidePopover();
                            }}
                          >
                            <button
                              disabled={busy}
                              onClick={() => navigateToScreen(`${project.id}/edit`)}
                            >
                              Edit
                            </button>
                            {!terminal.has(project.state) &&
                              !["paused", "needs_attention"].includes(project.state) && (
                                <button
                                  disabled={busy || Boolean(project.stopRequested)}
                                  onClick={() => {
                                    void control("pause");
                                  }}
                                >
                                  Pause
                                </button>
                              )}
                            {project.state === "paused" && (
                              <button
                                disabled={busy}
                                onClick={() => {
                                  void control("resume");
                                }}
                              >
                                Resume
                              </button>
                            )}
                            {!terminal.has(project.state) && (
                              <button
                                disabled={busy}
                                onClick={() => {
                                  void control("cancel");
                                }}
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                    <p className="project-brief">{project.prompt}</p>

                    <p className="project-meta">
                      {project.attemptCount} {project.attemptCount === 1 ? "run" : "runs"} <span>·</span>{" "}
                      Max parallel runs {project.maxWip} <span>·</span> Created {time(project.createdAt)}
                    </p>
                    {project.error && (
                      <div className="status-message" role="alert">
                        {projectErrorMessage(project)}
                        {errorReference(project.error) && (
                          <details>
                            <summary>Error reference</summary>
                            <p>{errorReference(project.error)}</p>
                          </details>
                        )}
                      </div>
                    )}
                    {["failed", "needs_attention"].includes(project.state) && (
                      <div className="status-message">
                        <span>
                          {workflowPermissionError
                            ? "After updating permissions, retry publishing your saved patches."
                            : "Retry resumes saved work when possible, or starts a new run."}
                        </span>
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() => {
                            void control("retry");
                          }}
                        >
                          {busy
                            ? "Retrying…"
                            : workflowPermissionError
                              ? "Retry publication"
                              : "Retry"}
                        </button>
                      </div>
                    )}
                    {project.attempts
                      ?.filter((attempt) => attempt.ciRepair?.state === "failed")
                      .map((attempt) => (
                        <div className="status-message" key={attempt.id}>
                          <span>Repair failed for PR #{attempt.pullRequest?.number}.</span>
                          {attempt.ciRepair?.canRetry &&
                            !project.stopRequested &&
                            ["queued", "running", "awaiting_review"].includes(project.state) &&
                            attempt.pullRequest?.state === "open" && (
                              <button
                                className="primary"
                                disabled={busy}
                                onClick={() => {
                                  void control("retry-repair", attempt.ciRepair!.id);
                                }}
                              >
                                {busy ? "Retrying…" : "Retry repair"}
                              </button>
                            )}
                        </div>
                      ))}
                    {project.stopRequested && (
                      <p className="subtle-note">
                        {project.stopRequested === "pause" ? "Pause" : "Cancellation"} requested. The
                        current run will finish before stopping.
                      </p>
                    )}
                    <hr className="project-divider" />
                    <AttemptHistory
                      key={project.id}
                      project={project}
                      events={events}
                      eventsState={eventsState}
                      eventsError={eventsError}
                      time={time}
                    />
                  </section>
                )}
                {project && selectedRun && (
                  <AttemptHistory
                    key={project.id}
                    project={project}
                    selected={selectedRun}
                    events={events}
                    eventsState={eventsState}
                    eventsError={eventsError}
                    time={time}
                  />
                )}
                {selected && !project && projectsLoaded && (
                  <section className="empty-state">
                    <h2>Project not found</h2>
                    <button className="text-button" onClick={navigateToList}>
                      Back to projects
                    </button>
                  </section>
                )}
              </>
            )}
            {editing && !project && projectsLoaded && (
              <section className="empty-state">
                <h2>Project not found</h2>
                <button className="text-button" onClick={navigateToList}>
                  Back to projects
                </button>
              </section>
            )}
            {(creating || (editing && project && project.state !== "cancelled")) && formDraft && (
              <section aria-label={editing ? "Edit project" : "New project"}>
                <form
                  onSubmit={(event) => {
                    void (editing ? saveProjectEdit(event) : createProject(event));
                  }}
                >
                  {editing ? (
                    <label>
                      Repository
                      <input readOnly value={formDraft.repository} />
                      <span>Existing runs and pull requests belong to this repository.</span>
                    </label>
                  ) : (
                    <>
                      <RepositorySelect
                        repositories={repositories}
                        value={draft.repository}
                        onChange={(repository) => edit({ repository })}
                        loading={repositoryLoading}
                        disabled={busy}
                        onRefresh={() => setRepositoryRefresh((current) => current + 1)}
                      />
                      <div
                        className="repository-discovery"
                        role={repositoryLoading ? "status" : undefined}
                      >
                        {repositoryLoading && <span>Checking repository access…</span>}
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => {
                            void connectRepositories();
                          }}
                        >
                          Add repositories
                        </button>
                      </div>
                      {repositoryError && (
                        <div className="status-message" role="alert">
                          {repositoryError}
                        </div>
                      )}
                      {repositories.length === 0 && !repositoryLoading && !repositoryError && (
                        <div className="status-message">
                          No repositories available. Connect the GitHub App to a public repository
                          you can access.
                        </div>
                      )}
                    </>
                  )}
                  {editing && (
                    <label>
                      Project name
                      <input
                        autoFocus
                        required
                        disabled={busy}
                        value={formDraft.name ?? ""}
                        onChange={(event) => editForm({ name: event.target.value })}
                      />
                    </label>
                  )}
                  <label>
                    What should Herbie work on?
                    <textarea
                      disabled={busy}
                      required
                      rows={4}
                      maxLength={8000}
                      placeholder="For example, add validation to the signup form and cover it with tests."
                      value={formDraft.prompt}
                      onChange={(event) => editForm({ prompt: event.target.value })}
                    />
                  </label>
                  <label>
                    Maximum work in progress
                    <input
                      disabled={busy}
                      type="number"
                      min="1"
                      max="2147483647"
                      required
                      value={formDraft.maxWip}
                      onChange={(event) => editForm({ maxWip: event.target.value })}
                    />
                    <span>Open pull requests and the run preparing the next one.</span>
                  </label>
                  {editing && (
                    <p className="subtle-note">
                      Prompt changes apply to future runs. Existing work will finish before a lower
                      work limit takes effect.
                    </p>
                  )}
                  {formError && (
                    <div className="status-message" role="alert">
                      {formError}
                    </div>
                  )}
                  <div className="form-actions">
                    {editing && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => navigateToScreen(selected!, true)}
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      className="primary"
                      type="submit"
                      disabled={
                        busy ||
                        !projectsLoaded ||
                        (editing
                          ? !formDraft.name?.trim() || !formDraft.prompt.trim()
                          : repositoryLoading ||
                            !repositoriesResolved ||
                            repositories.length === 0 ||
                            Boolean(repositoryError))
                      }
                    >
                      {busy
                        ? editing
                          ? "Saving…"
                          : "Starting…"
                        : editing
                          ? "Save changes"
                          : "Start project"}
                    </button>
                  </div>
                </form>
              </section>
            )}
          </>
        )}
      </main>
      <footer className="version-footer">
        {revision ? (
          <>
            Version{" "}
            <a
              href={`https://github.com/cmraible/herbie/commit/${revision}`}
              title={revision}
              target="_blank"
              rel="noreferrer"
            >
              <code>{revision.slice(0, 7)}</code>
            </a>
          </>
        ) : (
          "Version unavailable"
        )}
      </footer>
    </div>
  );
}
