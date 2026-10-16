import { githubPermissionsMessage, type Goal, type GoalEvent } from "@herbie/contracts";

export function errorReference(message: string): string | null {
  return /Reference:\s*([a-z0-9-]+)/i.exec(message)?.[1] ?? null;
}

export function activityMessage(goal: Goal, event: GoalEvent): string | null {
  const run = goal.attempts?.find((attempt) => attempt.id === event.attemptId);
  const runNumber = run?.number ?? Number(/Run #(\d+)/.exec(event.message)?.[1] ?? 1);
  const pullRequest = run?.pullRequest ?? goal.pullRequests.at(-1) ?? goal.pullRequest;
  const prNumber = pullRequest?.number;

  switch (event.type) {
    case "queued":
    case "retry":
      return `Run #${runNumber} queued`;
    case "attempt_started":
      return `Run #${runNumber} started`;
    case "renamed":
      return null;
    case "prompt_updated":
      return "Instructions updated. New runs will use them";
    case "updated":
      return "Project settings updated. New runs will use them";
    case "pause":
      return "Project pause requested";
    case "resume":
      return "Project resume requested";
    case "cancel":
      return "Project cancelled";
    case "attempt":
    case "ci_repair": {
      const stage = /Attempt stage: ([a-z_]+)/.exec(event.message)?.[1];
      if (stage === "sandbox_creation") return "Preparing the agent's environment";
      if (stage === "repository_clone") return `Cloning ${goal.repository}`;
      if (stage === "model_execution") return "Agent started working";
      if (stage === "runtime_preparation" || stage === "runtime_upload") return null;
      if (stage === "artifact_download" || stage === "sandbox_deletion") return null;
      if (event.message.startsWith("Goal completed in sandbox ")) return "Preparing pull request";
      return null;
    }
    case "publication_phase":
    case "artifact_ready":
    case "paused":
    case "publishing":
    case "publication_retry_queued":
    case "artifact_recovered":
    case "cancellation_cleanup":
    case "cleanup_required":
      return null;
    case "pull_request_opened":
      return prNumber ? `Pull request #${prNumber} opened` : "Pull request opened";
    case "pull_request_ready":
      return prNumber
        ? `Pull request #${prNumber} is ready for review`
        : "Pull request is ready for review";
    case "ci_repair_retry_queued":
      return "Manual repair retry queued";
    case "ci_repair_started":
      return "Agent is fixing failing checks";
    case "external_change_paused":
      return prNumber
        ? `Pull request #${prNumber} was changed outside Herbie. Agent paused`
        : "Pull request was changed outside Herbie. Agent paused";
    case "ci_repair_completed":
      return event.message.startsWith("Locally verified CI fix pushed") && prNumber
        ? `Fix pushed to pull request #${prNumber}. Waiting for checks`
        : null;
    case "ci_repair_failed":
      return event.message.startsWith("CI repair lease expired")
        ? `Agent was interrupted while fixing checks. ${prNumber ? `Pull request #${prNumber}` : "The pull request"} needs your attention`
        : `Agent couldn't fix the failing checks. ${prNumber ? `Pull request #${prNumber}` : "The pull request"} needs your attention`;
    case "recovery_required":
      if (event.message.startsWith("Worker connection was lost during an attempt"))
        return `Run #${runNumber} was interrupted. Retry to start a new run`;
      return null;
    case "publication_uncertain":
      return event.message.startsWith("A pull request appeared")
        ? null
        : "Preparing the pull request is taking longer than expected. Retrying automatically";
    case "publication_blocked":
      if (workflowPermissionMessage(event.message)) return workflowPermissionMessage(event.message);
      if (event.message.includes("saved artifact lacks matching test and cleanup evidence"))
        return "Run failed. Your patches are saved.";
      if (event.message.includes("attempt branch exists"))
        return "Pull request was changed outside Herbie. Agent paused";
      if (event.message.includes("original base"))
        return "Repository history changed. Agent paused";
      return "Pull request preparation paused. Your patches are saved.";
    case "failed":
    case "needs_attention":
      if (event.message.startsWith("Live execution is disabled"))
        return "Live runs aren't configured yet";
      return event.message.startsWith("Run failed. Your patches are saved")
        ? "Run failed. Your patches are saved."
        : "Run failed. No patches were saved.";
    case "pull_request_merged":
      return prNumber ? `Pull request #${prNumber} merged` : "Pull request merged";
    case "pull_request_closed":
      return prNumber
        ? `Pull request #${prNumber} closed without merging. Project paused`
        : "Pull request closed without merging. Project paused";
    default:
      return null;
  }
}

export function goalErrorMessage(goal: Goal): string {
  const error = goal.error ?? "";
  const permission = workflowPermissionMessage(error);
  if (permission) return permission;
  if (error.includes("Worker connection was lost during an attempt"))
    return `Run #${goal.attemptCount} was interrupted. Retry to start a new run`;
  if (error.includes("saved artifact lacks matching test and cleanup evidence"))
    return "Run failed. Your patches are saved.";
  if (error.startsWith("Run failed.")) return error.split(" Reference:")[0];
  if (error.startsWith("Attempt failed")) return "Run failed. No patches were saved.";
  if (error.includes("Publication remains unconfirmed"))
    return "Preparing the pull request is taking longer than expected. Retrying automatically";
  if (error.includes("CI repair stopped"))
    return "Agent couldn't fix the failing checks. Pull request needs your attention";
  if (error.includes("original base")) return "Repository history changed. Agent paused";
  if (error.includes("attempt branch exists"))
    return "Pull request preparation paused. Agent paused";
  if (error.startsWith("Live execution is disabled")) return "Live runs aren't configured yet";
  return "This project needs your attention.";
}

export function workflowPermissionMessage(error: string): string | null {
  if (error.startsWith("Automatic publication recovery stopped: installation_permissions_missing"))
    return `${githubPermissionsMessage}. Your patches are saved. Automatic retries are paused. Approve the updated permissions on GitHub, then retry publication.`;
  if (!error.startsWith("Automatic publication recovery stopped: workflow_permission_missing"))
    return null;
  const path =
    /workflow_permission_missing \((\.github\/workflows\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,200}\.ya?ml)\)/.exec(
      error,
    )?.[1];
  return `GitHub permission required. Herbie couldn't push changes to ${path ?? "a workflow file"}. Its GitHub App needs Workflows: Read and write permission. Your patches are saved. Automatic retries are paused. Update the app's installation permissions, then retry publication.`;
}
