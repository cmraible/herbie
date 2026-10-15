import { registerDiagnosticSecret } from "./diagnostic-log.js";
import { Daytona } from "@daytona/sdk";
import { runDaytonaAttempt } from "@herbie/loop/daytona-attempt";
import { publishPatch } from "@herbie/loop/publish-patch";
import {
  KnownAttemptFailure,
  PublicationBlockedError,
  type Adapters,
  type PublicationPhase,
} from "./adapters.js";
import type { Auth } from "./auth.js";
import type { Github } from "./github.js";

export interface LiveConfig {
  apiKey: string;
  apiUrl?: string;
  target?: string;
  openaiSecretName: string;
  snapshot?: string;
  domainAllowList?: string;
  outboundProxyUrl?: string;
}
export function createLiveAdapters(
  config: LiveConfig | undefined,
  github: Github,
  auth: Pick<Auth, "userToken">,
): Adapters {
  registerDiagnosticSecret(config?.apiKey);
  if (config && (!config.apiKey.trim() || !config.openaiSecretName.trim()))
    throw new Error(
      "Live mode requires Daytona API key and an existing OpenAI Daytona secret name",
    );
  if (config?.apiUrl) {
    const url = new URL(config.apiUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("Daytona API URL must use HTTPS without credentials");
  }
  return {
    mode: "live",
    async repositories(userId) {
      return github.repositories(await auth.userToken(userId));
    },
    async authorize(userId, repository) {
      return github.authorize(await auth.userToken(userId), repository);
    },
    reconciliationRepository: (repository) => github.reconciliationRepository(repository),
    async attempt(execution, report) {
      registerDiagnosticSecret(execution.goal.prompt);
      if (!config) throw new KnownAttemptFailure("Live execution is disabled by the operator");
      const openPullRequests = execution.goal.pullRequests.filter((pr) => pr.state === "open");
      const goal =
        openPullRequests.length === 0
          ? execution.goal.prompt
          : `${execution.goal.prompt}

Other pull requests for this goal are still open:
${openPullRequests.map((pr) => `- ${pr.url} (branch: ${pr.branch})`).join("\n")}
Inspect these branches before choosing your change. Make one small, independently mergeable contribution on the current default branch. Do not duplicate or depend on their unmerged changes.`;
      const daytona = new Daytona({
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        target: config.target,
        requestTimeoutMs: 30_000,
      });
      const changes = await runDaytonaAttempt(
        (params, options) => daytona.create(params, options),
        {
          signal: execution.signal,
          repoUrl: `https://github.com/${execution.repository.repository}.git`,
          goal,
          secrets: { OPENAI_API_KEY: config.openaiSecretName },
          snapshot: config.snapshot,
          domainAllowList: config.domainAllowList,
          outboundProxyUrl: config.outboundProxyUrl,
        },
        report,
      );
      return changes;
    },
    async publish(execution, changes, requireLease, reportPhase) {
      if (!config) throw new KnownAttemptFailure("Live execution is disabled by the operator");
      // Authorize again at publication; a removed user permission must stop new writes.
      await reportPhase?.("authorization");
      const access = await github.authorize(
        await auth.userToken(execution.goal.ownerId),
        execution.repository.repository,
      );
      await reportPhase?.("installation_token");
      const token = await github.installationToken(access.installationId, access.repository);
      await reportPhase?.("existing_pr_check");
      const existing = await github.findPullRequest(token, access.repository, execution.branch);
      if (existing) return existing;
      await requireLease();
      if (!changes.pullRequestBody?.trim())
        throw new PublicationBlockedError(
          "Saved artifact has no agent-authored pull request description",
        );
      const title =
        changes.pullRequestTitle ?? `Herbie: ${execution.goal.prompt.split("\n")[0].slice(0, 180)}`;
      const published = await publishPatch(
        (request) => github.openPullRequest(token, request, requireLease),
        {
          beforeWrite: requireLease,
          onPhase: async (stage) => {
            const phases: Record<typeof stage, PublicationPhase> = {
              preparing: "git_preparation",
              pushing: "branch_push",
              "opening-pr": "pull_request_creation",
              published: "publication_confirmation",
            };
            await reportPhase?.(phases[stage]);
          },
          repository: access.repository,
          baseBranch: access.defaultBranch,
          branch: execution.branch,
          title,
          body: changes.pullRequestBody,
          changes,
          gitEnvironment: {
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_COUNT: "3",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
            GIT_CONFIG_KEY_1: "credential.helper",
            GIT_CONFIG_VALUE_1: "",
            GIT_CONFIG_KEY_2: "core.hooksPath",
            GIT_CONFIG_VALUE_2: "/dev/null",
            GIT_AUTHOR_NAME: "Herbie",
            GIT_AUTHOR_EMAIL: "herbie@example.invalid",
            GIT_COMMITTER_NAME: "Herbie",
            GIT_COMMITTER_EMAIL: "herbie@example.invalid",
          },
        },
      );
      await reportPhase?.("publication_confirmation");
      const confirmed = await github.findPullRequest(token, access.repository, execution.branch);
      if (!confirmed || confirmed.url !== published.url)
        throw new Error("Published PR could not be reconciled");
      return confirmed;
    },
    async reconcile(execution) {
      const token = await github.installationToken(
        execution.repository.installationId,
        execution.repository.repository,
        "read",
      );
      return github.findPullRequest(token, execution.repository.repository, execution.branch);
    },
    async checkUnpublished(execution) {
      // The owner-authenticated API already obtained this repository with the
      // App's read-only reconciliation access. Archival must not block safe
      // cancellation of prior work; this check never authorizes a new write.
      const access = execution.repository;
      const token = await github.installationToken(
        access.installationId,
        access.repository,
        "read",
      );
      if (await github.findPullRequest(token, access.repository, execution.branch))
        return "pull_request_exists";
      if (await github.branchCommit(token, access.repository, execution.branch))
        return "branch_exists";
      return "absent";
    },
    async checkPublicationRetry(execution, changes) {
      const userToken = await auth.userToken(execution.goal.ownerId);
      const access = await github.authorize(userToken, execution.goal.repository);
      const token = await github.installationToken(
        access.installationId,
        access.repository,
        "read",
      );
      if (await github.findPullRequest(token, access.repository, execution.branch))
        return "pull_request_exists";
      if (await github.branchCommit(token, access.repository, execution.branch))
        return "branch_exists";
      const head = await github.branchCommit(token, access.repository, access.defaultBranch);
      if (
        !head ||
        (head !== changes.baseCommit &&
          !(await github.isAncestor(token, access.repository, changes.baseCommit, head)))
      )
        return "base_changed";
      return "ready";
    },
  };
}
