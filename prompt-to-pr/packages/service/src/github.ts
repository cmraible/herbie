import { createSign } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AttentionRequired } from "./artifact.js";
import { ApiError, type Repository } from "@prompt-to-pr/contracts";

export type PullRequest = { number: number; url: string; headSha: string };
export class GitHubError extends Error {
  constructor(public status: number) {
    super(`GitHub request failed (${status})`);
  }
}

export class GitHub {
  constructor(
    private appId: string,
    private privateKey: string,
  ) {}

  private appToken() {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.appId })}`;
    const signature = createSign("RSA-SHA256").update(payload).sign(this.privateKey, "base64url");
    return `${payload}.${signature}`;
  }

  async appInfo() {
    return this.request<{ slug: string }>("/app", this.appToken());
  }
  async appInstallation(repository: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
    return this.request<{ id: number }>(`/repos/${repository}/installation`, this.appToken());
  }

  async repositories(token: string): Promise<Array<Repository & { installationId: number }>> {
    const result: Array<Repository & { installationId: number }> = [];
    for (let page = 1; page <= 100; page++) {
      const { installations } = await this.request<{
        installations: Array<{ id: number; permissions: Record<string, string> }>;
      }>(`/user/installations?per_page=100&page=${page}`, token);
      for (const installation of installations) {
        if (
          installation.permissions.contents !== "write" ||
          installation.permissions.pull_requests !== "write"
        )
          continue;
        for (let repoPage = 1; repoPage <= 100; repoPage++) {
          const { repositories } = await this.request<{
            repositories: Array<{
              id: number;
              full_name: string;
              default_branch: string;
              archived: boolean;
              disabled: boolean;
              permissions?: { push?: boolean };
            }>;
          }>(
            `/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`,
            token,
          );
          for (const repo of repositories)
            if (!repo.archived && !repo.disabled && repo.permissions?.push)
              result.push({
                id: repo.id,
                fullName: repo.full_name,
                defaultBranch: repo.default_branch,
                installationId: installation.id,
              });
          if (repositories.length < 100) break;
          if (repoPage === 100) throw new Error("Repository discovery exceeded its limit");
        }
      }
      if (installations.length < 100) return result.sort((a, b) => a.id - b.id);
    }
    throw new Error("Installation discovery exceeded its limit");
  }

  async authorize(token: string, repositoryId: number) {
    const repo = (await this.repositories(token)).find((repo) => repo.id === repositoryId);
    if (!repo)
      throw new ApiError(
        403,
        "repository_access",
        "Connect the GitHub App to a repository where you have push access",
      );
    return repo;
  }

  async request<T>(path: string, token: string, method = "GET", body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`https://api.github.com${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
          },
          ...(method !== "GET" && body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
      } catch (error) {
        if (method !== "GET" || attempt === 2) throw error;
        await delay(250 * 2 ** attempt);
        continue;
      }
      if (response.ok)
        return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
      const retryAfter = Number(response.headers.get("retry-after") || "0");
      if (
        method !== "GET" ||
        attempt === 2 ||
        ![429, 500, 502, 503, 504].includes(response.status) ||
        retryAfter > 2
      )
        throw new GitHubError(response.status);
      await response.body?.cancel();
      await delay(Math.max(250 * 2 ** attempt, retryAfter * 1000));
    }
  }

  async installationToken(installationId: number, repositoryId: number, write: boolean) {
    const result = await this.request<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`,
      this.appToken(),
      "POST",
      {
        repository_ids: [repositoryId],
        permissions: write ? { contents: "write", pull_requests: "write" } : { contents: "read" },
      },
    );
    return result.token;
  }

  async head(repository: string, branch: string, token: string): Promise<string | null> {
    try {
      const ref = await this.request<{ object: { sha: string } }>(
        `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
        token,
      );
      return ref.object.sha;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  async findPullRequest(
    repository: string,
    branch: string,
    token: string,
  ): Promise<PullRequest | null> {
    const owner = repository.split("/")[0];
    const prs = await this.request<
      Array<{
        number: number;
        html_url: string;
        head: { sha: string; ref: string; repo: { full_name: string } | null };
      }>
    >(
      `/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
      token,
    );
    const matches = prs.filter(
      (pr) =>
        pr.head.ref === branch &&
        pr.head.repo?.full_name.toLowerCase() === repository.toLowerCase(),
    );
    if (matches.length > 1)
      throw new AttentionRequired("multiple_prs", "More than one PR exists for this run branch");
    return matches[0]
      ? { number: matches[0].number, url: matches[0].html_url, headSha: matches[0].head.sha }
      : null;
  }

  async openPullRequest(
    repository: string,
    branch: string,
    base: string,
    title: string,
    body: string,
    token: string,
  ): Promise<PullRequest> {
    const pr = await this.request<{ number: number; html_url: string; head: { sha: string } }>(
      `/repos/${repository}/pulls`,
      token,
      "POST",
      {
        head: branch,
        base,
        title,
        body,
        draft: true,
      },
    );
    return { number: pr.number, url: pr.html_url, headSha: pr.head.sha };
  }
}
