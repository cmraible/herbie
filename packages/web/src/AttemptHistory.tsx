import { useState } from "react";
import type { Goal, GoalEvent } from "@herbie/contracts";
import { attemptLabels, groupAttempts } from "./attempts.js";
import { activityMessage, errorReference } from "./activity-message.js";

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
                <div>
                  <span className="run-result-label">Pull request</span>
                  <strong>
                    #{pr.number}
                    {pr.title ? ` · ${pr.title}` : ""}
                  </strong>
                  <p className="pr-metadata">
                    <span>
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
                  </p>
                  {pr.body && <p className="pr-description">{pr.body}</p>}
                  <code>{pr.branch}</code>
                </div>
                <a className="run-result-link" href={pr.url} target="_blank" rel="noreferrer">
                  {pr.state === "open" ? "Review on GitHub" : "View on GitHub"} ↗
                </a>
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
