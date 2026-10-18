import { type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentTranscript } from "./AgentTranscript.js";
import type { Project, ProjectEvent } from "@herbie/contracts";
import { attemptLabels, groupAttempts, reviewLabel } from "./attempts.js";
import { activityMessage, errorReference } from "./activity-message.js";

function MarkdownCode({ className, children }: ComponentProps<"code">) {
  if (className !== "language-diff" || typeof children !== "string") {
    return <code className={className}>{children}</code>;
  }
  return (
    <code className={className}>
      {children.split(/(?<=\n)/).map((line, index) => (
        <span
          key={index}
          className={
            line.startsWith("@@")
              ? "diff-hunk"
              : line.startsWith("+")
                ? "diff-addition"
                : line.startsWith("-")
                  ? "diff-deletion"
                  : undefined
          }
        >
          {line}
        </span>
      ))}
    </code>
  );
}

export function AttemptHistory({
  project,
  events,
  eventsState,
  eventsError,
  time,
  selected = null,
}: {
  selected?: string | null;
  project: Project;
  events: ProjectEvent[];
  eventsState: string;
  eventsError: string | null;
  time: (value: string) => string;
}) {
  const { attempts, history } = groupAttempts(project, events);
  const groups = [
    ...attempts.map((attempt) => ({
      id: attempt.id,
      title: `Run ${attempt.number}`,
      createdAt: attempt.createdAt,
      status:
        attempt.pullRequest?.state === "merged"
          ? "Merged"
          : attempt.pullRequest?.state === "closed"
            ? "Closed"
            : attempt.state === "awaiting_review"
              ? reviewLabel(attempt.pullRequest)
              : attemptLabels[attempt.state],
      color:
        attempt.pullRequest?.state === "merged"
          ? "merged"
          : attempt.pullRequest?.state === "closed"
            ? "cancelled"
            : attempt.state === "awaiting_review" &&
                reviewLabel(attempt.pullRequest) === "Waiting for checks"
              ? "waiting_for_checks"
              : attempt.state,
      events: attempt.events,
      pullRequests: attempt.pullRequest ? [attempt.pullRequest] : [],
    })),
    ...(history.length
      ? [
          {
            id: "project-activity",
            title: "Project activity",
            createdAt: null,
            status: "",
            color: "",
            events: history,
            pullRequests: [],
          },
        ]
      : []),
  ];
  const group = groups.find((item) => item.id === selected);
  return (
    <section className="attempts" aria-label={selected ? "Run details" : "Runs"}>
      {!selected && <h3>Runs</h3>}
      {eventsState === "loading" && (
        <p className="subtle-note" role="status">
          Loading activity…
        </p>
      )}
      {eventsError && (
        <p className="subtle-note" role="status">
          Activity could not refresh; showing the latest events.
        </p>
      )}
      {!selected && groups.length > 0 ? (
        <nav className="run-list" aria-label="Run history">
          {groups.map((item) => (
            <div className="run-row" key={item.id}>
              <a className="run-select" href={`#${project.id}/runs/${item.id}`}>
                <span>{item.title}</span>
                {item.status && <span className={`badge status-${item.color}`}>{item.status}</span>}
              </a>
              {item.createdAt && (
                <time className="project-meta" dateTime={item.createdAt}>
                  Created {time(item.createdAt)}
                </time>
              )}
              {item.pullRequests.map((pr) => (
                <a
                  className="run-pr-link"
                  key={pr.branch}
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{pr.number}
                  {pr.title ? ` · ${pr.title}` : ""}
                </a>
              ))}
            </div>
          ))}
        </nav>
      ) : group ? (
        <section id="run-detail" className="run-panel" aria-labelledby="run-title">
          {!group.pullRequests.length && (
            <div className="run-panel-heading">
              <h2 id="run-title">
                {selected === "project-activity" ? group.title : "Agent progress"}
              </h2>
              {group.status && (
                <span className={`badge status-${group.color}`}>{group.status}</span>
              )}
            </div>
          )}
          {group.pullRequests.map((pr) => (
            <div className="run-result" key={pr.branch}>
              <div className="pr-header">
                <div className="pr-heading">
                  <h2 id="run-title" className="pr-title">
                    {pr.title}
                    <span className="pr-number">
                      {pr.title ? " · " : ""}#{pr.number}
                    </span>
                  </h2>
                </div>
                <a
                  className="run-result-link"
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={pr.state === "open" ? "Review on GitHub" : "View on GitHub"}
                  title={pr.state === "open" ? "Review on GitHub" : "View on GitHub"}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.768-.244.768-.542 0-.267-.01-.974-.015-1.912-3.13.68-3.791-1.508-3.791-1.508-.512-1.3-1.25-1.646-1.25-1.646-1.022-.7.078-.686.078-.686 1.13.08 1.725 1.16 1.725 1.16 1.005 1.723 2.637 1.225 3.279.937.102-.728.393-1.225.715-1.507-2.499-.284-5.126-1.25-5.126-5.565 0-1.23.44-2.233 1.16-3.02-.116-.285-.503-1.43.11-2.98 0 0 .945-.303 3.094 1.154A10.78 10.78 0 0 1 12 6.18c.956.005 1.92.129 2.82.38 2.148-1.457 3.091-1.154 3.091-1.154.615 1.55.228 2.695.112 2.98.722.787 1.158 1.79 1.158 3.02 0 4.326-2.631 5.278-5.138 5.557.404.35.766 1.04.766 2.097 0 1.515-.014 2.737-.014 3.109 0 .3.202.65.774.54A11.25 11.25 0 0 0 12 .75Z" />
                  </svg>
                  {pr.state === "open" ? "Review on GitHub" : "View on GitHub"}
                </a>
              </div>
              <div className="pr-metadata">
                {group.status && (
                  <span className={`badge status-${group.color}`}>{group.status}</span>
                )}
                {pr.changedFiles !== undefined && (
                  <span>
                    {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"} changed
                  </span>
                )}
                {pr.additions !== undefined && (
                  <span className="pr-additions" aria-label={`${pr.additions} additions`}>
                    +{pr.additions}
                  </span>
                )}
                {pr.deletions !== undefined && (
                  <span className="pr-deletions" aria-label={`${pr.deletions} deletions`}>
                    −{pr.deletions}
                  </span>
                )}
              </div>
              {pr.body && (
                <div className="pr-description">
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{ code: MarkdownCode }}
                    skipHtml
                  >
                    {pr.body}
                  </Markdown>
                </div>
              )}
              <details className="pr-branch">
                <summary>Source branch</summary>
                <code>{pr.branch}</code>
              </details>
            </div>
          ))}
          {project.attempts
            ?.find((run) => run.id === group.id)
            ?.sessions?.map((session, index) => (
              <details
                key={session.id}
                className="agent-session"
                open={session.state === "running"}
              >
                <summary>
                  Session {index + 1} ·{" "}
                  {
                    {
                      implementation: "Implementation",
                      ci_repair: "Check repair",
                      pr_feedback: "Review feedback",
                    }[session.kind]
                  }{" "}
                  · {session.state}
                </summary>
                <p>
                  {session.model} · {session.reasoningEffort} reasoning · Started{" "}
                  {time(session.startedAt)}
                  {session.finishedAt ? ` · Finished ${time(session.finishedAt)}` : ""}
                </p>
                {session.environment && (
                  <p>
                    Environment: {session.environment.provider} · {session.environment.id} · Cleanup{" "}
                    {session.cleanup}
                  </p>
                )}
                {session.usage && (
                  <details>
                    <summary>Token usage</summary>
                    <pre>{JSON.stringify(session.usage, null, 2)}</pre>
                  </details>
                )}
                <AgentTranscript
                  events={group.events.filter((event) => event.agentSessionId === session.id)}
                />
                <ol>
                  {group.events
                    .filter(
                      (event) => event.agentSessionId === session.id && event.type !== "agent",
                    )
                    .map((event) => {
                      const text = activityMessage(project, event);
                      if (!text) return null;
                      return (
                        <li key={event.id}>
                          {text} <time dateTime={event.createdAt}>{time(event.createdAt)}</time>
                        </li>
                      );
                    })}
                </ol>
              </details>
            ))}
          <AgentTranscript events={group.events.filter((event) => !event.agentSessionId)} />
          <section className="activity">
            <h3>Run activity</h3>
            {group.events
              .filter((event) => !event.agentSessionId)
              .every((event) => activityMessage(project, event) === null) ? (
              <p className="subtle-note">
                {eventsState === "loading" ? "Loading activity…" : "No activity yet."}
              </p>
            ) : (
              <ol>
                {group.events
                  .filter((event) => !event.agentSessionId)
                  .map((event) => {
                    const text = activityMessage(project, event);
                    if (!text) return null;
                    const number = /Pull request #(\d+)/.exec(text)?.[1];
                    const pullRequest = group.pullRequests.find(
                      (pr) => pr.number === Number(number),
                    );
                    return (
                      <li key={event.id}>
                        <span>
                          {pullRequest ? (
                            <a href={pullRequest.url} target="_blank" rel="noreferrer">
                              {text}
                            </a>
                          ) : (
                            text
                          )}
                        </span>
                        <time dateTime={event.createdAt}>{time(event.createdAt)}</time>
                        {errorReference(event.message) && (
                          <details>
                            <summary>Error reference</summary>
                            <p>{errorReference(event.message)}</p>
                          </details>
                        )}
                      </li>
                    );
                  })}
              </ol>
            )}
          </section>
        </section>
      ) : (
        <p className="subtle-note">
          {eventsState === "loading"
            ? "Loading runs…"
            : selected
              ? "Run not found."
              : "No runs yet. Activity will appear here when the agent starts."}
        </p>
      )}
    </section>
  );
}
