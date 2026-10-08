import { z } from 'zod';
import { goalInput, goalSchema, eventSchema, sessionSchema, repositorySchema, authStartSchema, authPollSchema, actionSchema, type GoalInput, type GoalAction } from './index.js';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}

/** Browser-safe transport shared by the CLI and web. Sessions are never part of job data. */
export function createClient(options: { baseUrl?: string; token?: string; origin?: string } = {}) {
  const baseUrl = options.baseUrl?.replace(/\/$/, '') ?? '';
  async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, requestId?: string): Promise<T> {
    const headers = new Headers({accept: 'application/json'});
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (body !== undefined && options.origin) headers.set('origin', options.origin);
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    if (requestId) headers.set('idempotency-key', z.uuid().parse(requestId));
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers, credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new ApiError(response.status, `Service returned a non-JSON response (HTTP ${response.status})`); }
    if (!response.ok) {
      const error = z.object({error: z.string()}).safeParse(data);
      throw new ApiError(response.status, error.success ? error.data.error : `Service returned HTTP ${response.status}`);
    }
    return schema.parse(data);
  }
  const goalPath = (id: string) => `/api/goals/${z.uuid().parse(id)}`;
  return {
    health: () => request('/api/health', z.object({mode: z.enum(['demo','live'])})),
    session: () => request('/api/session', sessionSchema),
    repositories: () => request('/api/repositories', z.array(repositorySchema)),
    goals: () => request('/api/goals', z.array(goalSchema)),
    goal: (id: string) => request(goalPath(id), goalSchema),
    start: (input: GoalInput, requestId: string) => request('/api/goals', goalSchema, goalInput.parse(input), requestId),
    events: (id: string, after = 0) => request(`${goalPath(id)}/events?after=${z.number().int().nonnegative().parse(after)}`, z.array(eventSchema)),
    action: (id: string, action: GoalAction) => request(`${goalPath(id)}/${actionSchema.parse(action)}`, goalSchema, {}),
    authStart: (client: 'cli'|'web') => request('/api/auth/start', authStartSchema, {client}),
    authPoll: (token: string) => request(`/api/auth/poll?token=${encodeURIComponent(token)}`, authPollSchema),
    demoLogin: () => request('/api/demo/login', sessionSchema, {client: 'web'}),
    demoCliLogin: () => request('/api/demo/login', z.object({token: z.string().min(1), session: sessionSchema}), {client: 'cli'}),
    logout: () => request('/api/auth/logout', z.object({ok: z.literal(true)}), {}),
    demoAction: (id: string, action: 'merge'|'close') => request(`/api/demo/goals/${z.uuid().parse(id)}/${action}`, goalSchema, {}),
  };
}
