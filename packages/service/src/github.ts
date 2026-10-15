import { registerDiagnosticSecret, logFailure } from "./diagnostic-log.js";
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Repository } from "@herbie/contracts";
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
  }),
});
function requiredPermissions({ permissions }: z.infer<typeof installationSchema>): boolean {
  return (
    permissions.contents === "write" &&
    permissions.pull_requests === "write" &&
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
  number: z.number().int(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  head: z.object({ ref: z.string() }),
  base: z.object({ ref: z.string() }),
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
  async function request(path: string, token: string, body?: unknown): Promise<unknown> {
    registerDiagnosticSecret(token);
    if (Date.now() < retryAt) throw new GithubError(429, "GitHub rate limit cooldown");
    const response = await fetch(`${api}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const secondaryLimit =
      response.status === 403 &&
      /secondary rate limit|abuse detection/i.test(await response.clone().text());
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
    if (!response.ok)
      throw new GithubError(
        [401, 403, 404].includes(response.status) ? response.status : 502,
        response.status === 401
          ? "GitHub authorization expired or was revoked; log in again"
          : `GitHub request failed (${response.status})`,
      );
    return response.json();
  }
  function jwt() {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId })).toString("base64url")}`;
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(config.privateKey, "base64url")}`;
  }
  async function repositories(token: string): Promise<Repository[]> {
    const result: Repository[] = [];
    for (let page = 1; page <= 100; page++) {
      const installations = z
        .object({ installations: z.array(installationSchema) })
        .parse(await request(`/user/installations?per_page=100&page=${page}`, token)).installations;
      for (const installation of installations) {
        if (!requiredPermissions(installation)) continue;
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
            if (!repo.private && !repo.archived && !repo.disabled && repo.permissions?.push)
              result.push({
                fullName: repo.full_name,
                defaultBranch: repo.default_branch,
                installationId: installation.id,
              });
          if (repos.length < 100) break;
          if (repoPage === 100) throw new Error("Repository listing exceeds supported limit");
        }
      }
      if (installations.length < 100) return result;
    }
    throw new Error("Installation listing exceeds supported limit");
  }
  async function authorize(token: string, repository: string): Promise<RepositoryAccess> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new GithubError(400, "Invalid repository");
    const repo = repositorySchema.parse(await request(`/repos/${repository}`, token));
    if (repo.private) throw new GithubError(403, "Only public repositories are supported");
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
      throw new GithubError(
        403,
        "Update the GitHub App installation permissions: Contents and Pull requests write, plus Checks, Commit statuses and Actions read are required",
      );
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
    const pr = list.find((item) => item.head.ref === branch);
    if (!pr) return null;
    if (!pr.html_url.startsWith(`https://github.com/${repository}/pull/`))
      throw new Error("Unexpected GitHub pull request URL");
    return {
      url: pr.html_url,
      number: pr.number,
      branch,
      state: pr.merged_at ? "merged" : pr.state,
    };
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
    permission: "read" | "write" = "write",
    ci = false,
  ) {
    if (
      !Number.isSafeInteger(installationId) ||
      installationId < 1 ||
      !/^[\w.-]+\/[\w.-]+$/.test(repository)
    )
      throw new Error("Invalid repository installation");
    // Installation tokens can be stateless ghs_APPID_JWT values (base64url + dots).
    // Accept bearer-token characters without assuming GitHub's opaque token layout.
    const value = z
      .object({ token: z.string().regex(/^[A-Za-z0-9._~+/-]+=*$/), expires_at: z.string() })
      .parse(
        await request(`/app/installations/${installationId}/access_tokens`, jwt(), {
          repositories: [repository.split("/")[1]],
          permissions: {
            contents: permission,
            pull_requests: permission,
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
    for (const sha of refs.reverse()) {
      const details: unknown[] = [];
      let pending = false,
        passing = true,
        succeeded = false,
        evidence = false;
      const contexts: { context: string; app: number | null }[] = [];
      // A fast check can finish before another suite has created its check runs.
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
        for (const suite of suites) {
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
        if (suites.length < 100) break;
      }
      for (let page = 1; ; page++) {
        if (page > 10) throw new Error("CI check listing exceeds supported limit");
        const checks = z
          .object({
            check_runs: z.array(
              z.object({
                id: z.number().int(),
                name: z.string(),
                app: z.object({ id: z.number() }),
                status: z.string(),
                conclusion: z.string().nullable(),
                details_url: z.string().nullable(),
                output: z.object({
                  title: z.string().nullable(),
                  summary: z.string().nullable(),
                  text: z.string().nullable(),
                }),
              }),
            ),
          })
          .parse(
            await request(
              `/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
              token,
            ),
          ).check_runs;
        for (const check of checks) {
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
          const job = check.details_url?.startsWith(
            `https://github.com/${repository}/actions/runs/`,
          )
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
        if (checks.length < 100) break;
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
      if (!evidence && !contexts.length) continue;
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
    ciStatus,
    repositories,
    authorize,
    findPullRequest,
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
      if (!pr.draft) return true; // Reconcile a prior successful mutation after a lost response.
      await beforeWrite();
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
      if (repo.private) throw new GithubError(403, "Only public repositories are supported");
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
        return {
          url: pr.html_url,
          number: pr.number,
          branch: input.head,
          state: pr.merged_at ? "merged" : pr.state,
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
