/** Portable domain: no Cloudflare, Daytona, HTTP or SDK types. */
export type RunStatus = 'queued' | 'running' | 'publishing' | 'done' | 'failed';
export interface Run {
  id: string; branch: string; prompt: string; version: number;
  kind: 'create' | 'repair'; pr?: number; feedback: string[];
  status: RunStatus; attempt: number; startedAt?: number; checkpoint?: string;
}
export interface PullRequest { number: number; branch: string; head: string; state: 'open' | 'merged' | 'closed'; feedback: string[] }
export interface Goal {
  id: string; workspace: string; repo: string; prompt: string; version: number;
  target: number; status: 'active' | 'paused'; reason?: string;
  runs: Run[]; prs: PullRequest[]; events: string[];
  activity: { at: number; message: string }[];
  lease?: { owner: string; until: number };
}
export function validatePrompt(prompt: string, target: number) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw new Error('Invalid prompt');
  if (!Number.isInteger(target) || target < 1 || target > 10) throw new Error('Target must be 1–10');
}
export function createGoal(id: string, workspace: string, repo: string, prompt: string, target = 1): Goal {
  validatePrompt(prompt, target);
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) throw new Error('Invalid repository');
  return { id, workspace, repo, prompt, version: 1, target, status: 'active', runs: [], prs: [], events: [], activity: [] };
}
export function editGoal(g: Goal, prompt: string, target: number, status: Goal['status']) {
  validatePrompt(prompt, target);
  if (status !== 'active' && status !== 'paused') throw new Error('Invalid status');
  if (g.prompt !== prompt) g.version++;
  g.prompt = prompt; g.target = target; g.status = status; delete g.reason;
}
export function active(r: Run) { return !['done', 'failed'].includes(r.status); }
export function outstanding(g: Goal) {
  return g.prs.filter(p => p.state === 'open').length + g.runs.filter(r => r.kind === 'create' && active(r)).length;
}
export function record(g: Goal, at: number, message: string) {
  g.activity.push({ at, message });
  g.activity = g.activity.slice(-200);
}
export function reserve(g: Goal, now: number) {
  if (g.status !== 'active') return;
  for (const p of g.prs.filter(p => p.state === 'open' && p.feedback.length)) {
    if (!g.runs.some(r => r.pr === p.number && active(r))) {
      addRun(g, now, p); p.feedback = [];
    }
  }
  while (outstanding(g) < g.target) addRun(g, now);
}
function addRun(g: Goal, now: number, pr?: PullRequest) {
  const id = `${g.id}-${g.runs.length + 1}`;
  g.runs.push({ id, branch: pr?.branch ?? `herbie/${id}`, prompt: g.prompt, version: g.version,
    kind: pr ? 'repair' : 'create', pr: pr?.number, feedback: [...pr?.feedback ?? []], status: 'queued', attempt: 1 });
  record(g, now, `Reserved ${id} using prompt v${g.version}`);
}
export function feedback(g: Goal, event: string, pr: number, message: string) {
  if (g.events.includes(event)) return;
  const p = g.prs.find(p => p.number === pr);
  if (!p || p.state !== 'open') return;
  g.events.push(event);
  p.feedback.push(message.slice(0, 12000));
}
