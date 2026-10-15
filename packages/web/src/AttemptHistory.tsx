import { useState } from "react";
import type { Goal, GoalEvent } from "@herbie/contracts";
import { attemptLabels, groupAttempts } from "./attempts.js";

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
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined);
  const { attempts } = groupAttempts(goal, events);
  const groups = attempts.map((attempt) => ({
    id: attempt.id,
    title: `Attempt ${attempt.number}`,
    status:
      attempt.pullRequest?.state === "merged"
        ? "Merged"
        : attempt.pullRequest?.state === "closed"
          ? "Closed"
          : attemptLabels[attempt.state],
    color:
      attempt.pullRequest?.state === "merged"
        ? "completed"
        : attempt.pullRequest?.state === "closed"
          ? "cancelled"
          : attempt.state,
    events: attempt.events,
    pullRequests: attempt.pullRequest ? [attempt.pullRequest] : [],
  }));
  const open = expanded === undefined ? groups[0]?.id : expanded;
  return (
    <section className="attempts" aria-label="Attempts">
      <h3>Attempts</h3>
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
      {groups.map((group) => (
        <section className="attempt" key={group.id}>
          <h4>
            <button
              className="attempt-toggle"
              aria-expanded={open === group.id}
              aria-controls={`attempt-${group.id}`}
              onClick={() => setExpanded(open === group.id ? null : group.id)}
            >
              <span>{group.title}</span>
              {group.status && (
                <span className={`badge status-${group.color}`}>{group.status}</span>
              )}
              <span className="attempt-chevron" aria-hidden="true">
                {open === group.id ? "−" : "+"}
              </span>
            </button>
          </h4>
          <div id={`attempt-${group.id}`} hidden={open !== group.id} className="attempt-body">
            {group.pullRequests.map((pr) => (
              <div className="pr-card" key={pr.branch}>
                <strong>Pull request #{pr.number}</strong>
                <span>
                  {pr.state === "open" ? "Ready for your review." : `Pull request ${pr.state}.`}
                </span>
                <a href={pr.url} target="_blank" rel="noreferrer">
                  Review on GitHub ↗
                </a>
              </div>
            ))}
            <section className="activity">
              <h3>Activity</h3>
              {group.events.length === 0 ? (
                <p className="subtle-note">
                  {eventsState === "loading" ? "Loading activity…" : "No activity yet."}
                </p>
              ) : (
                <ol>
                  {group.events.map((event) => (
                    <li key={event.id}>
                      <span>{event.message}</span>
                      <time>
                        {time(event.createdAt)} · {event.type.replaceAll("_", " ")}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        </section>
      ))}
    </section>
  );
}
