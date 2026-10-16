import type { Run, Project, ProjectEvent } from "@herbie/contracts";

export const runLabels: Record<Run["state"], string> = {
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

export function groupRuns(project: Project, events: ProjectEvent[]) {
  const runs = (project.runs ?? []).map((run) => ({
    ...run,
    events: [] as ProjectEvent[],
  }));
  const history: ProjectEvent[] = [];
  let legacyRun: (typeof runs)[number] | undefined;
  for (const event of events) {
    let run = runs.find((item) => item.id === event.runId);
    if (event.runId === undefined) {
      // Older servers did not include event attribution.
      history.push(event);
      continue;
    }
    if (!event.runId) {
      if (["run_started", "queued", "retry"].includes(event.type)) {
        const number =
          /Run #(\d+)/.exec(event.message)?.[1] ?? (event.type === "queued" ? "1" : undefined);
        legacyRun = runs.find((item) => item.number === Number(number));
        run = legacyRun;
      } else if (
        ["run", "artifact_ready", "publishing", "publication_phase"].includes(event.type)
      ) {
        run = legacyRun;
      } else if (event.type === "pull_request_opened") {
        run = runs.find((item) => item.pullRequest && event.message.includes(item.pullRequest.url));
      }
    }
    (run?.events ?? history).push(event);
  }
  return { runs: runs.reverse(), history };
}

export function reviewLabel(pr: Project["pullRequest"]): string {
  return pr?.state === "open" && pr.draft === false && pr.checksPassed === true
    ? "Ready for review"
    : "Waiting for checks";
}

export function projectReadyForReview(project: Project): boolean {
  return (
    project.state === "awaiting_review" &&
    (project.pullRequests.length ? project.pullRequests : [project.pullRequest]).some(
      (pr) => reviewLabel(pr) === "Ready for review",
    )
  );
}
