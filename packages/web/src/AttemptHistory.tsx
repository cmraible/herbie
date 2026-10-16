import { useState, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Goal, GoalEvent } from "@herbie/contracts";
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
  goal,
  events,
  eventsState,
  eventsError,
  time,
}: {
  goal: Goal;
  events: GoalEvent[];
  eventsState: string;
  eventsError: string | null;
  time: (value: string) => string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const { attempts, history } = groupAttempts(goal, events);
  const groups = [
    ...attempts.map((attempt) => ({
      id: attempt.id,
      title: `Run ${attempt.number}`,
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
            : attempt.state,
      events: attempt.events,
      pullRequests: attempt.pullRequest ? [attempt.pullRequest] : [],
    })),
    ...(history.length
      ? [
          {
            id: "project-activity",
            title: "Project activity",
            status: "",
            color: "",
            events: history,
            pullRequests: [],
          },
        ]
      : []),
  ];
  const group = groups.find((item) => item.id === selected) ?? groups[0];
  return (
    <section className="attempts" aria-label="Runs">
      <h3>Runs</h3>
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
      {group ? (
        <div className="run-layout">
          <nav className="run-list" aria-label="Run history">
            {groups.map((item) => (
              <button
                key={item.id}
                className="run-select"
                aria-pressed={group.id === item.id}
                aria-controls="run-detail"
                onClick={() => setSelected(item.id)}
              >
                <span>{item.title}</span>
                {item.status && <span className={`badge status-${item.color}`}>{item.status}</span>}
              </button>
            ))}
          </nav>
          <section id="run-detail" className="run-panel" aria-labelledby="run-title">
            <div className="run-panel-heading">
              <h4 id="run-title">{group.title}</h4>
              {group.status && (
                <span className={`badge status-${group.color}`}>{group.status}</span>
              )}
            </div>
            {group.pullRequests.map((pr) => (
              <div className="run-result" key={pr.branch}>
                <div className="pr-header">
                  <div className="pr-heading">
                    <span className="run-result-label">Pull request</span>
                    <h5 className="pr-title">
                      #{pr.number}
                      {pr.title ? ` · ${pr.title}` : ""}
                    </h5>
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
                  </a>
                </div>
                <div className="pr-metadata">
                  <span
                    className={`badge pr-state-${pr.draft && pr.state === "open" ? "draft" : pr.state}`}
                  >
                    {pr.state === "open"
                      ? pr.draft
                        ? "Draft"
                        : "Open"
                      : pr.state === "merged"
                        ? "Merged"
                        : "Closed"}
                  </span>
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
            <section className="activity">
              <h3>Activity</h3>
              {group.events.every((event) => activityMessage(goal, event) === null) ? (
                <p className="subtle-note">
                  {eventsState === "loading" ? "Loading activity…" : "No activity yet."}
                </p>
              ) : (
                <ol>
                  {group.events.map((event) => {
                    const text = activityMessage(goal, event);
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
        </div>
      ) : (
        <p className="subtle-note">
          {eventsState === "loading"
            ? "Loading runs…"
            : "No runs yet. Activity will appear here when the agent starts."}
        </p>
      )}
    </section>
  );
}
