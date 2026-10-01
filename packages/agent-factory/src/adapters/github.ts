import { importPKCS8, SignJWT } from 'jose';
import type { PullRequest, Run } from '../core/model.js';
import type { Repository } from '../core/ports.js';
interface GitHubPR { number: number; state: string; merged_at: string | null; head: { ref: string; sha: string; repo: { full_name: string } | null } }
export class GitHub implements Repository {
  constructor(private appId: string, private pem: string, private installation: number,
    private transport: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  async token(repo: string, writePR = true) {
    const key = await importPKCS8(this.pem.replaceAll('\\n', '\n'), 'RS256');
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(this.appId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 60).setExpirationTime('9m').sign(key);
    const result = await this.request<{ token: string }>(`/app/installations/${this.installation}/access_tokens`, jwt, {
      method: 'POST', body: JSON.stringify({ repositories: [repo.split('/')[1]], permissions: {
        contents: 'write', ...(writePR ? { pull_requests: 'write', checks: 'read', actions: 'read', issues: 'write' } : {}) } }) });
    return result.token;
  }
  async request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const r = await this.transport(`https://api.github.com${path}`, { ...init, signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
        'User-Agent': 'herbie-agent-factory', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!r.ok) throw new Error(`GitHub request failed (${r.status})`);
    return await r.json() as T;
  }
  private toPR(pr: GitHubPR, repo: string): PullRequest {
    if (pr.head.repo?.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error('Foreign PR repository');
    return { number: pr.number, branch: pr.head.ref, head: pr.head.sha,
      state: pr.merged_at ? 'merged' : pr.state === 'open' ? 'open' : 'closed', feedback: [] };
  }
  async inspect(repo: string, number: number) {
    const token = await this.token(repo);
    return this.toPR(await this.request<GitHubPR>(`/repos/${repo}/pulls/${number}`, token), repo);
  }
  async publish(repo: string, run: Run) {
    const token = await this.token(repo);
    if (run.pr) {
      const pr = await this.inspect(repo, run.pr);
      if (pr.state !== 'open') return pr;
      // Idempotent progress reply: marker is durable on GitHub, not in the VM.
      const marker = `<!-- herbie:${run.id} -->`;
      let found = false;
      for (let page = 1; ; page++) {
        const comments = await this.request<{ body: string }[]>(`/repos/${repo}/issues/${run.pr}/comments?per_page=100&page=${page}`, token);
        if (comments.some(c => c.body.includes(marker))) { found = true; break; }
        if (comments.length < 100) break;
        if (page >= 20) throw new Error('Comment history exceeds automatic reconciliation limit');
      }
      if (!found) await this.request(`/repos/${repo}/issues/${run.pr}/comments`, token, {
        method: 'POST', body: JSON.stringify({ body: `${marker}\nAddressed queued review/CI feedback in ${run.checkpoint}. Please review the updated changes and checks.` }) });
      return pr;
    }
    const found = await this.request<GitHubPR[]>(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0] + ':' + run.branch)}`, token);
    if (found.length) return this.toPR(found[0], repo);
    const info = await this.request<{ default_branch: string }>(`/repos/${repo}`, token);
    const pr = await this.request<GitHubPR>(`/repos/${repo}/pulls`, token, { method: 'POST', body: JSON.stringify({
      head: run.branch, base: info.default_branch, draft: true, title: (run.summary?.problem ?? 'Small improvement toward the goal').split('\n')[0].slice(0, 150),
      body: `${run.summary?.problem ?? 'Small improvement toward the configured goal.'}\n\n${run.summary?.change ?? 'See the focused diff.'}\n\nVerification: ${run.summary?.verification ?? 'Review CI before merging.'}\n\n<!-- herbie:${run.id}; prompt-v${run.version}; checkpoint:${run.checkpoint} -->`,
    }) });
    return this.toPR(pr, repo);
  }
}
