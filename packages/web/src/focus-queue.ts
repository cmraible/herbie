import type { Attempt, Project } from "@herbie/contracts";
import { reviewLabel } from "./attempts.js";

export type FocusTask = { id: string; project: Project; attempt?: Attempt; attention: boolean };

export function focusQueue(projects: Project[], ownerId: string): FocusTask[] {
  return projects
    .flatMap((project): FocusTask[] => {
      if (project.ownerId !== ownerId || ["completed", "cancelled"].includes(project.state))
        return [];
      const attempts = project.attempts ?? [];
      const latest = attempts
        .filter((run) => ["failed", "needs_attention", "publishing"].includes(run.state))
        .reduce<Attempt | undefined>(
          (last, run) => (!last || run.number > last.number ? run : last),
          undefined,
        );
      const needsAttention =
        ["failed", "needs_attention"].includes(project.state) && !project.stopRequested;
      const tasks = attempts.flatMap((attempt): FocusTask[] => {
        const pr = attempt.pullRequest;
        if (pr && pr.state !== "open") return [];
        const attention =
          (needsAttention && attempt.id === latest?.id) ||
          (pr?.state === "open" && attempt.ciRepair?.state === "failed");
        if (!attention && reviewLabel(pr) !== "Ready for review") return [];
        return [{ id: `${project.id}/${attempt.id}`, project, attempt, attention }];
      });
      if (needsAttention && !tasks.some((task) => task.attention))
        tasks.push({ id: project.id, project, attention: true });
      return tasks;
    })
    .sort(
      (a, b) =>
        Number(b.attention) - Number(a.attention) ||
        (a.attempt?.createdAt ?? a.project.createdAt).localeCompare(
          b.attempt?.createdAt ?? b.project.createdAt,
        ) ||
        a.id.localeCompare(b.id),
    );
}
