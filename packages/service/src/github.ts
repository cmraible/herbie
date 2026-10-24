import { githubFeedback } from "./github-feedback.js";
import { registerDiagnosticSecret, logFailure } from "./diagnostic-log.js";
import { createHash, createHmac, createSign, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  githubPermissionsMessage,
  type RepositoryDiscovery,
  type Repository,
} from "@herbie/contracts";
import type { PullRequest, RepositoryAccess, CiStatus } from "./adapters.js";

export interface GithubConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  callbackUrl: string;
  webhookSecret: string;
}
export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: "github_permissions_required",
    readonly githubResponse?: {
      method: string;
      url: string;
      status: number;
      statusText: string;
      metadata: Record<string, string>;
      body: unknown;
    },
  ) {
    super(message);
  }
}
const repositorySchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  private: z.boolean(),
  archived: z.boolean().default(false),
  disabled: z.boolean().default(false),
  default_branch: z.string(),
  permissions: z.object({ push: z.boolean().optional() }).optional(),
});
const installationSchema = z.object({
  id: z.number().int(),
  permissions: z.object({
    contents: z.string().optional(),
    pull_requests: z.string().optional(),
    checks: z.string().optional(),
    statuses: z.string().optional(),
    actions: z.string().optional(),
    workflows: z.string().optional(),
  }),
});
function requiredPermissions({ permissions }: z.infer<typeof installationSchema>): boolean {
  return (
    permissions.contents === "write" &&
    permissions.pull_requests === "write" &&
    permissions.workflows === "write" &&
    [permissions.checks, permissions.statuses, permissions.actions].every(
      (value) => value === "read" || value === "write",
    )
  );
}
const branchSchema = z.object({
  commit: z.object({ sha: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/) }),
});
const appSchema = z.object({
  slug: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/),
});
const pullSchema = z.object({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  number: z.number().int(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  head: z.object({
    ref: z.string(),
    sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  }),
  base: z.object({
    ref: z.string(),
    sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  }),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
});

export function createGithub(config: GithubConfig, testEndpoints?: { api: string; oauth: string }) {
  if (Object.values(config).some((value) => !value.trim()))
    throw new Error("Complete GitHub App configuration is required");
  const callback = new URL(config.callbackUrl);
  if (
    callback.protocol !== "https:" ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  )
    throw new Error("GitHub callback must be a trusted HTTPS URL");
  for (const endpoint of Object.values(testEndpoints ?? {})) {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
      throw new Error("Test endpoints must be loopback HTTP");
  }
  const api = testEndpoints?.api ?? "https://api.github.com";
  const oauth = testEndpoints?.oauth ?? "https://github.com";
  // A shared cooldown also covers freshly issued tokens after installation throttling.
  let retryAt = 0;
  async function request(
    path: string,
    token: string,
    body?: unknown,
    accept = "application/vnd.github+json",
    method: "POST" | "PUT" = "POST",
  ): Promise<unknown> {
    registerDiagnosticSecret(token);
    if (Date.now() < retryAt) throw new GithubError(429, "GitHub rate limit cooldown");
    const response = await fetch(`${api}${path}`, {
      method: body === undefined ? "GET" : method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const errorBody = response.ok ? undefined : await response.text();
    const secondaryLimit =
      response.status === 403 && /secondary rate limit|abuse detection/i.test(errorBody ?? "");
    if (
      response.status === 429 ||
      secondaryLimit ||
      (response.status === 403 &&
        (response.headers.has("retry-after") ||
          response.headers.get("x-ratelimit-remaining") === "0"))
    ) {
      const retry = response.headers.get("retry-after");
      const delay =
        retry === null
          ? 0
          : /^\d+$/.test(retry)
            ? Date.now() + Number(retry) * 1000
            : Date.parse(retry);
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      retryAt = Math.max(
        Date.now() + 60_000,
        Number.isFinite(delay) ? delay : 0,
        Number.isFinite(reset) ? reset : 0,
      );
    }
    if (!response.ok) {
      let details: unknown = errorBody;
      try {
        details = JSON.parse(errorBody!);
      } catch {
        // GitHub and upstream proxies may return plain text or HTML errors.
      }
      const metadata: Record<string, string> = {};
      for (const header of [
        "x-github-request-id",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
        "x-ratelimit-resource",
        "retry-after",
        "x-accepted-github-permissions",
        "x-oauth-scopes",
        "x-accepted-oauth-scopes",
      ]) {
        const value = response.headers.get(header);
        if (value !== null) metadata[header] = value;
      }
      // Keep the public message stable; private diagnostics serialize and redact
      // these response details using the existing size and credential limits.
      throw new GithubError(
        [401, 403, 404].includes(response.status) ? response.status : 502,
        response.status === 401
          ? "GitHub authorization expired or was revoked; log in again"
          : `GitHub request failed (${response.status})`,
        undefined,
        {
          method: body === undefined ? "GET" : method,
          url: `${api}${path}`,
          status: response.status,
          statusText: response.statusText,
          metadata,
          body: details,
        },
      );
    }
    return accept === "application/vnd.github.diff" ? response.text() : response.json();
  }
  function jwt() {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId })).toString("base64url")}`;
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(config.privateKey, "base64url")}`;
  }
  async function discoverRepositories(token: string): Promise<RepositoryDiscovery> {
    let permissionsRequired = false;
    const result: Repository[] = [];
    for (let page = 1; page <= 100; page++) {
      const installations = z
        .object({ installations: z.array(installationSchema) })
        .parse(await request(`/user/installations?per_page=100&page=${page}`, token)).installations;
      for (const installation of installations) {
        if (!requiredPermissions(installation)) {
          permissionsRequired = true;
          continue;
        }
        for (let repoPage = 1; repoPage <= 100; repoPage++) {
          const repos = z
            .object({ repositories: z.array(repositorySchema) })
            .parse(
              await request(
                `/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`,
                token,
              ),
            ).repositories;
          for (const repo of repos)
            if (!repo.archived && !repo.disabled && repo.permissions?.push)
              result.push({
                fullName: repo.full_name,
                defaultBranch: repo.default_branch,
                installationId: installation.id,
              });
          if (repos.length < 100) break;
          if (repoPage === 100) throw new Error("Repository listing exceeds supported limit");
        }
      }
      if (installations.length < 100) return { repositories: result, permissionsRequired };
    }
    throw new Error("Installation listing exceeds supported limit");
  }
  async function repositories(token: string): Promise<Repository[]> {
    return (await discoverRepositories(token)).repositories;
  }
  async function authorize(token: string, repository: string): Promise<RepositoryAccess> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new GithubError(400, "Invalid repository");
    const repo = repositorySchema.parse(await request(`/repos/${repository}`, token));
    if (repo.archived || repo.disabled)
      throw new GithubError(
        403,
        "Repository is archived or disabled; new work cannot be published",
      );
    if (!repo.permissions?.push) throw new GithubError(403, "User write permission is required");
    const accessible = (await repositories(token)).find(
      (item) => item.fullName.toLowerCase() === repository.toLowerCase(),
    );
    if (!accessible)
      throw new GithubError(403, githubPermissionsMessage, "github_permissions_required");
    return {
      repository: accessible.fullName,
      defaultBranch: accessible.defaultBranch,
      installationId: accessible.installationId,
    };
  }
  async function findPullRequest(
    token: string,
    repository: string,
    branch: string,
  ): Promise<PullRequest | null> {
    const owner = repository.split("/")[0];
    const list = z
      .array(pullSchema)
      .parse(
        await request(
          `/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
          token,
        ),
      );
    const match = list.find((item) => item.head.ref === branch);
    if (!match) return null;
    const pr = pullSchema.parse(await request(`/repos/${repository}/pulls/${match.number}`, token));
    if (!pr.html_url.startsWith(`https://github.com/${repository}/pull/`))
      throw new Error("Unexpected GitHub pull request URL");
    const patchSha = await pullRequestPatchSha(token, repository, pr.number);
    return {
      title: pr.title,
      body: pr.body,
      draft: pr.draft,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      url: pr.html_url,
      number: pr.number,
      branch,
      state: pr.merged_at ? "merged" : pr.state,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      ...(patchSha ? { patchSha } : {}),
    };
  }
  async function pullRequestPatchSha(
    token: string,
    repository: string,
    number: number,
  ): Promise<string | undefined> {
    const files: { filename: string; status: string; changes: string[] }[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = z
        .array(
          z.object({
            filename: z.string(),
            status: z.string(),
            patch: z.string().optional(),
          }),
        )
        .parse(
          await request(
            `/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
            token,
          ),
        );
      if (batch.some((file) => file.patch === undefined)) return undefined;
      files.push(
        ...batch.map(({ filename, status, patch }) => ({
          filename,
          status,
          changes: patch!.split("\n").filter((line) => !line.startsWith("@@")),
        })),
      );
      if (batch.length < 100)
        return createHash("sha256").update(JSON.stringify(files)).digest("hex");
    }
    return undefined;
  }
  async function branchCommit(
    token: string,
    repository: string,
    branch: string,
  ): Promise<string | null> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !branch)
      throw new GithubError(400, "Invalid branch lookup");
    try {
      return branchSchema.parse(
        await request(`/repos/${repository}/branches/${encodeURIComponent(branch)}`, token),
      ).commit.sha;
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) return null;
      throw error;
    }
  }
  async function isAncestor(
    token: string,
    repository: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    try {
      const comparison = z
        .object({ merge_base_commit: z.object({ sha: z.string() }) })
        .parse(
          await request(
            `/repos/${repository}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}?per_page=1`,
            token,
          ),
        );
      return comparison.merge_base_commit.sha === ancestor;
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) return false;
      throw error;
    }
  }
  async function installationToken(
    installationId: number,
    repository: string,
    permission: "read" | "write" | "react" = "write",
    ci = false,
    workflows = false,
  ) {
    if (
      !Number.isSafeInteger(installationId) ||
      installationId < 1 ||
      !/^[\w.-]+\/[\w.-]+$/.test(repository)
    )
      throw new Error("Invalid repository installation");
    const workflowWrite = workflows && permission === "write";
    if (
      workflowWrite &&
      !requiredPermissions(
        installationSchema.parse(await request(`/repos/${repository}/installation`, jwt())),
      )
    )
      throw new GithubError(403, githubPermissionsMessage, "github_permissions_required");
    // Installation tokens can be stateless ghs_APPID_JWT values (base64url + dots).
    // Accept bearer-token characters without assuming GitHub's opaque token layout.
    const value = z
      .object({ token: z.string().regex(/^[A-Za-z0-9._~+/-]+=*$/), expires_at: z.string() })
      .parse(
        await request(`/app/installations/${installationId}/access_tokens`, jwt(), {
          repositories: [repository.split("/")[1]],
          permissions: {
            contents: permission === "react" ? "read" : permission,
            pull_requests: permission === "react" ? "write" : permission,
            ...(permission === "react" ? { issues: "write" } : {}),
            ...(workflowWrite ? { workflows: "write" } : {}),
            ...(ci ? { checks: "read", statuses: "read", actions: "read" } : {}),
          },
        }),
      );
    if (!(Date.parse(value.expires_at) > Date.now() + 30_000))
      throw new Error("GitHub installation token expired");
    return value.token;
  }
  async function requiredChecks(token: string, repository: string, base: string) {
    const [owner, name] = repository.split("/");
    const protection = z
      .object({
        errors: z.never().optional(),
        data: z.object({
          repository: z.object({
            ref: z.object({
              branchProtectionRule: z
                .object({
                  requiredStatusChecks: z
                    .array(
                      z.object({
                        context: z.string(),
                        app: z.object({ databaseId: z.number() }).nullable(),
                      }),
                    )
                    .nullable(),
                })
                .nullable(),
            }),
          }),
        }),
      })
      .parse(
        await request("/graphql", token, {
          query:
            "query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){branchProtectionRule{requiredStatusChecks{context app{databaseId}}}}}}",
          variables: { owner, name, ref: `refs/heads/${base}` },
        }),
      ).data.repository.ref.branchProtectionRule;
    const required = (protection?.requiredStatusChecks ?? []).map((check) => ({
      context: check.context,
      app: check.app?.databaseId ?? null,
    }));
    for (let page = 1; ; page++) {
      if (page > 10) throw new Error("Branch rules exceed supported limit");
      const rules = z
        .array(z.object({ type: z.string(), parameters: z.unknown().optional() }))
        .parse(
          await request(
            `/repos/${repository}/rules/branches/${encodeURIComponent(base)}?per_page=100&page=${page}`,
            token,
          ),
        );
      if (rules.some((rule) => rule.type === "workflows")) return null;
      for (const rule of rules)
        if (rule.type === "required_status_checks") {
          const parameters = z
            .object({
              required_status_checks: z.array(
                z.object({ context: z.string(), integration_id: z.number().nullable().optional() }),
              ),
            })
            .parse(rule.parameters);
          required.push(
            ...parameters.required_status_checks.map((check) => ({
              context: check.context,
              app: check.integration_id ?? null,
            })),
          );
        }
      if (rules.length < 100) break;
    }
    return required;
  }
  async function ciStatus(
    token: string,
    repository: string,
    number: number,
    branch: string,
  ): Promise<CiStatus | null> {
    const pr = z
      .object({
        state: z.string(),
        html_url: z.string(),
        merge_commit_sha: z.string().nullable(),
        mergeable: z.boolean().nullable(),
        base: z.object({ ref: z.string() }),
        draft: z.boolean(),
        head: z.object({
          sha: z.string().regex(/^[a-f0-9]{40}$/),
          ref: z.string(),
          repo: z.object({ full_name: z.string() }).nullable(),
        }),
      })
      .parse(await request(`/repos/${repository}/pulls/${number}`, token));
    if (
      pr.state !== "open" ||
      pr.head.ref !== branch ||
      pr.head.repo?.full_name.toLowerCase() !== repository.toLowerCase()
    )
      return null;
    if (pr.mergeable === null) return null;
    const refs = [
      ...new Set([
        pr.head.sha,
        ...(pr.mergeable && pr.merge_commit_sha ? [pr.merge_commit_sha] : []),
      ]),
    ];
    // Evaluate the populated merge ref first; never mix it with stale head results.
    for (const [refIndex, sha] of refs.reverse().entries()) {
      const details: unknown[] = [];
      let pending = false,
        passing = true,
        succeeded = false,
        evidence = false;
      const contexts: { context: string; app: number | null }[] = [];
      // A fast check can finish before another suite has created its check runs.
      const allSuites: {
        id: number;
        app: { slug: string };
        status: string;
        conclusion: string | null;
        latest_check_runs_count: number;
      }[] = [];
      for (let page = 1; ; page++) {
        if (page > 10) throw new Error("CI suite listing exceeds supported limit");
        const suites = z
          .object({
            check_suites: z.array(
              z.object({
                status: z.string(),
                conclusion: z.string().nullable(),
                latest_check_runs_count: z.number(),
                id: z.number(),
                app: z.object({ slug: z.string() }),
              }),
            ),
          })
          .parse(
            await request(
              `/repos/${repository}/commits/${sha}/check-suites?per_page=100&page=${page}`,
              token,
            ),
          ).check_suites;
        allSuites.push(...suites);
        if (suites.length < 100) break;
      }
      const checkSchema = z.object({
        id: z.number().int(),
        name: z.string(),
        app: z.object({ id: z.number() }),
        check_suite: z.object({ id: z.number() }).optional(),
        status: z.string(),
        conclusion: z.string().nullable(),
        details_url: z.string().nullable(),
        output: z.object({
          title: z.string().nullable(),
          summary: z.string().nullable(),
          text: z.string().nullable(),
        }),
      });
      const allChecks: z.infer<typeof checkSchema>[] = [];
      for (let page = 1; ; page++) {
        if (page > 10) throw new Error("CI check listing exceeds supported limit");
        const checks = z
          .object({
            check_runs: z.array(checkSchema),
          })
          .parse(
            await request(
              `/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
              token,
            ),
          ).check_runs;
        allChecks.push(...checks);
        if (checks.length < 100) break;
      }
      // GitHub's latest filter can retain checks from multiple workflow runs.
      // Only replace a cancellation with a newer check of the same name and app
      // on this commit; unrelated successful workflows cannot unblock it.
      const superseded = (check: z.infer<typeof checkSchema>) =>
        allChecks.some(
          (newer) =>
            newer.id > check.id && newer.name === check.name && newer.app.id === check.app.id,
        );
      for (const suite of allSuites) {
        const suiteChecks = allChecks.filter((check) => check.check_suite?.id === suite.id);
        if (
          suite.status === "completed" &&
          suite.conclusion === "cancelled" &&
          suiteChecks.length > 0 &&
          suiteChecks.length >= suite.latest_check_runs_count &&
          suiteChecks.every(superseded)
        )
          continue;
        if (suite.latest_check_runs_count > 0 || suite.status === "completed") evidence = true;
        if (suite.latest_check_runs_count > 0 && suite.status !== "completed") pending = true;
        if (
          (suite.latest_check_runs_count > 0 || suite.status === "completed") &&
          !["success", "neutral", "skipped"].includes(suite.conclusion ?? "")
        )
          passing = false;
        if (
          suite.status === "completed" &&
          ["failure", "timed_out", "action_required", "startup_failure"].includes(
            suite.conclusion ?? "",
          )
        )
          details.push({
            sha,
            suite: suite.id,
            app: suite.app.slug,
            conclusion: suite.conclusion,
          });
      }
      for (const check of allChecks) {
        if (check.status === "completed" && check.conclusion === "cancelled" && superseded(check))
          continue;
        contexts.push({ context: check.name, app: check.app.id });
        if (check.status !== "completed") pending = true;
        if (check.conclusion === "success") succeeded = true;
        if (!["success", "neutral", "skipped"].includes(check.conclusion ?? "")) passing = false;
        if (
          check.status !== "completed" ||
          !["failure", "timed_out", "action_required", "startup_failure"].includes(
            check.conclusion ?? "",
          )
        )
          continue;
        const annotations = z
          .array(z.object({ path: z.string(), start_line: z.number(), message: z.string() }))
          .parse(
            await request(
              `/repos/${repository}/check-runs/${check.id}/annotations?per_page=100`,
              token,
            ),
          );
        details.push({
          sha,
          name: check.name,
          conclusion: check.conclusion,
          url: check.details_url,
          output: JSON.stringify(check.output).slice(0, 12000),
          annotations: JSON.stringify(annotations).slice(0, 16000),
        });
        // Actions checks frequently have no output; include the failed workflow steps.
        const job = check.details_url?.startsWith(`https://github.com/${repository}/actions/runs/`)
          ? check.details_url.match(/\/job\/([0-9]+)$/)
          : null;
        if (job) {
          const steps = z
            .object({
              name: z.string(),
              steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })),
            })
            .parse(await request(`/repos/${repository}/actions/jobs/${job[1]}`, token));
          details.push(steps);
        }
      }
      const statuses = z
        .object({
          state: z.string(),
          total_count: z.number(),
          statuses: z.array(
            z.object({
              context: z.string(),
              state: z.string(),
              description: z.string().nullable(),
              target_url: z.string().nullable(),
            }),
          ),
        })
        .parse(await request(`/repos/${repository}/commits/${sha}/status?per_page=100`, token));
      contexts.push(...statuses.statuses.map((status) => ({ context: status.context, app: null })));
      if (statuses.total_count > 100) throw new Error("CI status listing exceeds supported limit");
      if (statuses.statuses.some((status) => status.state === "pending")) pending = true;
      if (statuses.statuses.some((status) => status.state === "success")) succeeded = true;
      if (statuses.statuses.some((status) => status.state !== "success")) passing = false;
      details.push(
        ...statuses.statuses.filter((status) => ["error", "failure"].includes(status.state)),
      );
      if (!evidence && !contexts.length) {
        const required = await requiredChecks(token, repository, pr.base.ref);
        if (required === null || required.length) continue;
        if (refIndex < refs.length - 1) continue;
        return {
          state: "passed",
          draft: pr.draft,
          head: pr.head.sha,
          pullRequest: { number, url: pr.html_url },
        };
      }
      if (pending) return null;
      if (!details.length) {
        if (!passing || !succeeded) return null;
        const required = await requiredChecks(token, repository, pr.base.ref);
        if (
          required === null ||
          required.some(
            (check) =>
              !contexts.some(
                (current) =>
                  current.context === check.context &&
                  (check.app === null || current.app === check.app),
              ),
          )
        )
          return null;
        return {
          state: "passed",
          draft: pr.draft,
          head: pr.head.sha,
          pullRequest: { number, url: pr.html_url },
        };
      }
      return {
        head: pr.head.sha,
        pullRequest: { number, url: pr.html_url },
        state: "failed",
        details: JSON.stringify(details).slice(0, 60000),
      };
    }
    return null;
  }
  return {
    ...githubFeedback(request),
    ciStatus,
    discoverRepositories,
    repositories,
    authorize,
    findPullRequest,
    async pullRequestAction(
      token: string,
      repository: string,
      number: number,
      action: "approve" | "merge",
      headSha: string,
      mergeMethod: "merge" | "squash" | "rebase",
    ) {
      const path = `/repos/${repository}/pulls/${number}`;
      const pr = pullSchema.parse(await request(path, token));
      if (pr.state !== "open" || pr.draft)
        throw new GithubError(409, "This pull request must be open and ready for review.");
      if (pr.head.sha !== headSha)
        throw new GithubError(
          409,
          "This pull request has changed. Refresh and review the latest changes.",
        );
      try {
        if (action === "approve") {
          await request(`${path}/reviews`, token, { event: "APPROVE", commit_id: headSha });
        } else {
          const result = z
            .object({ merged: z.boolean() })
            .parse(
              await request(
                `${path}/merge`,
                token,
                { sha: headSha, merge_method: mergeMethod },
                "application/vnd.github+json",
                "PUT",
              ),
            );
          if (!result.merged)
            throw new GithubError(
              409,
              "GitHub could not merge this pull request. Check required reviews and checks.",
            );
        }
      } catch (error) {
        if (
          error instanceof GithubError &&
          [403, 405, 409, 422].includes(error.githubResponse?.status ?? 0)
        )
          throw new GithubError(
            409,
            action === "approve"
              ? "GitHub could not approve this pull request. You cannot approve your own PR, and review permission is required."
              : "GitHub could not merge this pull request. Check permissions, required reviews, checks, conflicts, and the selected merge method.",
          );
        throw error;
      }
    },
    async pullRequestDiff(token: string, repository: string, number: number): Promise<string> {
      return z
        .string()
        .parse(
          await request(
            `/repos/${repository}/pulls/${number}`,
            token,
            undefined,
            "application/vnd.github.diff",
          ),
        );
    },
    branchCommit,
    isAncestor,
    installationToken,
    async readinessState(
      token: string,
      repository: string,
      number: number,
    ): Promise<"ready" | "draft" | "closed"> {
      const pr = z
        .object({ draft: z.boolean(), state: z.enum(["open", "closed"]) })
        .parse(await request(`/repos/${repository}/pulls/${number}`, token));
      return !pr.draft ? "ready" : pr.state === "closed" ? "closed" : "draft";
    },
    async requestReview(
      token: string,
      repository: string,
      number: number,
      ownerId: string,
      reviewerLogins?: string[] | null,
    ) {
      const user = z.object({ id: z.number().int(), login: z.string() });
      const path = `/repos/${repository}/pulls/${number}`;
      const pr = z
        .object({
          state: z.string(),
          draft: z.boolean(),
          user,
          requested_reviewers: z.array(user),
        })
        .parse(await request(path, token));
      if (pr.state !== "open") return;
      if (pr.draft) throw new Error("Cannot request review while PR is draft");
      const reviewers = reviewerLogins?.length
        ? [...new Set(reviewerLogins.map((login) => login.toLowerCase()))].map((login) => ({
            login,
          }))
        : [{ id: ownerId }];
      const reviews: { user: z.infer<typeof user> | null; state: string }[] = [];
      for (let page = 1; ; page++) {
        const batch = z
          .array(z.object({ user: user.nullable(), state: z.string() }))
          .parse(await request(`${path}/reviews?per_page=100&page=${page}`, token));
        reviews.push(...batch);
        if (batch.length < 100) break;
      }
      const pending: string[] = [];
      for (const target of reviewers) {
        const matches = (candidate: z.infer<typeof user> | null) =>
          "login" in target
            ? candidate?.login.toLowerCase() === target.login
            : String(candidate?.id) === target.id;
        // A retry must only notify reviewers who have not already been requested or reviewed.
        if (
          matches(pr.user) ||
          pr.requested_reviewers.some(matches) ||
          reviews.some((review) => matches(review.user) && review.state !== "PENDING")
        )
          continue;
        const reviewer = user.parse(
          await request(
            "login" in target
              ? `/users/${encodeURIComponent(target.login)}`
              : `/user/${encodeURIComponent(target.id)}`,
            token,
          ),
        );
        if (!matches(reviewer)) throw new Error("GitHub reviewer did not match requested user");
        pending.push(reviewer.login);
      }
      if (pending.length)
        await request(`${path}/requested_reviewers`, token, { reviewers: pending });
    },
    async mergeApproved(
      token: string,
      repository: string,
      number: number,
      branch: string,
      head: string,
      ownerId: string,
    ): Promise<boolean> {
      const path = `/repos/${repository}/pulls/${number}`;
      const pr = pullSchema.parse(await request(path, token));
      if (pr.state !== "open" || pr.draft || pr.head.ref !== branch || pr.head.sha !== head)
        return false;
      let approval: string | null = null;
      for (let page = 1; ; page++) {
        if (page > 10) throw new Error("PR reviews exceed supported listing limit");
        const reviews = z
          .array(
            z.object({
              user: z.object({ id: z.number().int() }).nullable(),
              state: z.string(),
              commit_id: z.string().nullable().optional(),
            }),
          )
          .parse(await request(`${path}/reviews?per_page=100&page=${page}`, token));
        for (const review of reviews) {
          if (String(review.user?.id) !== ownerId) continue;
          if (review.state === "APPROVED") approval = review.commit_id ?? null;
          if (review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED") approval = null;
        }
        if (reviews.length < 100) break;
      }
      if (approval !== head) return false;
      const status = await ciStatus(token, repository, number, branch);
      if (status?.state !== "passed" || status.draft || status.head !== head) return false;
      const latest = pullSchema.parse(await request(path, token));
      if (
        latest.state !== "open" ||
        latest.draft ||
        latest.head.ref !== branch ||
        latest.head.sha !== head
      )
        return false;
      try {
        const result = z
          .object({ merged: z.boolean() })
          .parse(
            await request(
              `${path}/merge`,
              token,
              { sha: head },
              "application/vnd.github+json",
              "PUT",
            ),
          );
        return result.merged;
      } catch (error) {
        // GitHub can reject a merge while branch protection is still settling.
        if (error instanceof GithubError && error.githubResponse?.status === 405) return false;
        throw error;
      }
    },
    async markReady(
      token: string,
      repository: string,
      number: number,
      branch: string,
      head: string,
      beforeWrite: () => Promise<void>,
    ): Promise<boolean> {
      const status = await ciStatus(token, repository, number, branch);
      if (status?.state !== "passed" || status.head !== head) return false;
      const pr = z
        .object({
          node_id: z.string(),
          draft: z.boolean(),
          state: z.string(),
          head: z.object({ sha: z.string(), ref: z.string() }),
        })
        .parse(await request(`/repos/${repository}/pulls/${number}`, token));
      if (pr.state !== "open" || pr.head.sha !== head || pr.head.ref !== branch) return false;
      await beforeWrite();
      if (!pr.draft) return true; // Reconcile a prior successful mutation after a lost response.
      // GitHub has no expected-head argument for this mutation; recheck immediately above.
      const result = z
        .object({
          data: z
            .object({
              markPullRequestReadyForReview: z.object({
                pullRequest: z.object({ id: z.string(), isDraft: z.literal(false) }),
              }),
            })
            .nullable()
            .optional(),
          errors: z.array(z.unknown()).optional(),
        })
        .parse(
          await request("/graphql", token, {
            query:
              "mutation($id:ID!) { markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { id isDraft } } }",
            variables: { id: pr.node_id },
          }),
        );
      if (
        result.errors?.length ||
        result.data?.markPullRequestReadyForReview.pullRequest.id !== pr.node_id
      )
        throw new Error("GitHub did not confirm that the PR is ready for review");
      return true;
    },
    async installationUrl(state: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error("Invalid installation state");
      const app = appSchema.parse(await request("/app", jwt()));
      const url = new URL(`/apps/${app.slug}/installations/new`, oauth);
      url.searchParams.set("state", state);
      return url.href;
    },
    async verifyUserInstallation(
      token: string,
      installationId: number,
    ): Promise<"ready" | "permissions" | "missing"> {
      if (!Number.isSafeInteger(installationId) || installationId < 1)
        throw new GithubError(400, "Invalid GitHub installation");
      for (let page = 1; page <= 100; page++) {
        const installations = z
          .object({ installations: z.array(installationSchema) })
          .parse(
            await request(`/user/installations?per_page=100&page=${page}`, token),
          ).installations;
        const installation = installations.find((item) => item.id === installationId);
        if (installation) return requiredPermissions(installation) ? "ready" : "permissions";
        if (installations.length < 100) return "missing";
      }
      throw new Error("Installation listing exceeds supported limit");
    },
    async reconciliationRepository(repository: string): Promise<RepositoryAccess> {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new GithubError(400, "Invalid repository");
      const installation = installationSchema.parse(
        await request(`/repos/${repository}/installation`, jwt()),
      );
      const token = await installationToken(installation.id, repository, "read");
      const repo = repositorySchema.parse(await request(`/repos/${repository}`, token));
      return {
        repository: repo.full_name,
        defaultBranch: repo.default_branch,
        installationId: installation.id,
      };
    },
    authorizationUrl(state: string, challenge: string) {
      const url = new URL(`${oauth}/login/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return url.href;
    },
    async authenticate(code: string, verifier: string) {
      const response = await fetch(`${oauth}/login/oauth/access_token`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.callbackUrl,
          code,
          code_verifier: verifier,
        }),
      });
      if (!response.ok)
        throw new GithubError(400, "GitHub authorization exchange failed; start login again");
      const parsedToken = tokenSchema.safeParse(await response.json());
      if (!parsedToken.success)
        throw new GithubError(400, "GitHub authorization exchange failed; start login again");
      const token = parsedToken.data;
      const user = z
        .object({ id: z.number().int(), login: z.string() })
        .parse(await request("/user", token.access_token));
      // Bound even non-expiring upstream tokens; reauthorization refreshes this first slice.
      return {
        user: { id: String(user.id), login: user.login },
        token: token.access_token,
        expiresAt: new Date(Date.now() + Math.min(token.expires_in ?? 28800, 28800) * 1000),
      };
    },
    async openPullRequest(
      token: string,
      input: {
        repository: string;
        base: string;
        head: string;
        title: string;
        body: string;
        draft: true;
      },
      beforeWrite?: () => Promise<void>,
    ) {
      const existing = await findPullRequest(token, input.repository, input.head);
      if (existing) return existing;
      await beforeWrite?.();
      try {
        const pr = pullSchema.parse(
          await request(`/repos/${input.repository}/pulls`, token, {
            base: input.base,
            head: input.head,
            title: input.title,
            body: input.body,
            draft: true,
          }),
        );
        const patchSha = await pullRequestPatchSha(token, input.repository, pr.number);
        return {
          title: pr.title,
          body: pr.body,
          draft: pr.draft,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changed_files,
          url: pr.html_url,
          number: pr.number,
          branch: input.head,
          state: pr.merged_at ? "merged" : pr.state,
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
          ...(patchSha ? { patchSha } : {}),
        };
      } catch (error) {
        logFailure(error, { component: "github-publication-response" });
        // Lost successful response or duplicate request: read the unique attempt branch.
        const recovered = await findPullRequest(token, input.repository, input.head);
        if (recovered) return recovered;
        throw error;
      }
    },
    verifyWebhook(body: Buffer, signature: string | undefined) {
      if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
      const expected = createHmac("sha256", config.webhookSecret).update(body).digest();
      return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
    },
  };
}
export type Github = ReturnType<typeof createGithub>;
