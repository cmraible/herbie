import type { Project, ProjectEvent } from "@herbie/contracts";

type ApiVersion = string | string[] | undefined;

function currentVersion(version: ApiVersion): string | undefined {
  return Array.isArray(version) ? version[0] : version;
}

export function apiProject(project: Project, version?: ApiVersion): unknown {
  const selected = currentVersion(version);
  if (selected === "3") return project;
  const { runCount, runs, ...rest } = project;
  const compatible = { ...rest, attemptCount: runCount, attempts: runs };
  if (selected === "2") return compatible;
  const { maxWip: _maxWip, pullRequests: _pullRequests, ...legacy } = compatible;
  return legacy;
}

export function apiEvents(events: ProjectEvent[], version?: ApiVersion): unknown {
  if (currentVersion(version) === "3") return events;
  return events.map(({ runId, ...event }) => ({
    ...event,
    type:
      event.type === "run"
        ? "attempt"
        : event.type === "run_started"
          ? "attempt_started"
          : event.type,
    message: event.message.replace(/\bRun\b/g, "Attempt"),
    attemptId: runId,
  }));
}
