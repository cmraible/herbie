import type { Attempt, Goal, GoalEvent } from "@herbie/contracts";

export const attemptLabels: Record<Attempt["state"], string> = {
  queued: "Queued",
  running: "Running",
  ready: "Ready to publish",
  publishing: "Publishing",
  awaiting_review: "Ready for review",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  needs_attention: "Needs attention",
};

export function groupAttempts(goal: Goal, events: GoalEvent[]) {
  const attempts = (goal.attempts ?? []).map((attempt) => ({
    ...attempt,
    events: [] as GoalEvent[],
  }));
  const history: GoalEvent[] = [];
  let legacyAttempt: (typeof attempts)[number] | undefined;
  for (const event of events) {
    let attempt = attempts.find((item) => item.id === event.attemptId);
    if (event.attemptId === undefined) {
      // Older servers did not include event attribution.
      history.push(event);
      continue;
    }
    if (!event.attemptId) {
      if (["attempt_started", "queued", "retry"].includes(event.type)) {
        const number =
          /Run #(\d+)/.exec(event.message)?.[1] ?? (event.type === "queued" ? "1" : undefined);
        legacyAttempt = attempts.find((item) => item.number === Number(number));
        attempt = legacyAttempt;
      } else if (
        ["attempt", "artifact_ready", "publishing", "publication_phase"].includes(event.type)
      ) {
        attempt = legacyAttempt;
      } else if (event.type === "pull_request_opened") {
        attempt = attempts.find(
          (item) => item.pullRequest && event.message.includes(item.pullRequest.url),
        );
      }
    }
    (attempt?.events ?? history).push(event);
  }
  return { attempts: attempts.reverse(), history };
}

export function reviewLabel(pr: Goal["pullRequest"]): string {
  return pr?.state === "open" && pr.draft === false && pr.checksPassed === true
    ? "Ready for review"
    : "Waiting for checks";
}

export function goalReadyForReview(goal: Goal): boolean {
  return (
    goal.state === "awaiting_review" &&
    (goal.pullRequests.length ? goal.pullRequests : [goal.pullRequest]).some(
      (pr) => reviewLabel(pr) === "Ready for review",
    )
  );
}
