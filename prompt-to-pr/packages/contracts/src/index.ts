import { z } from "zod";

export const runInput = z
  .object({
    repositoryId: z.number().int().positive().safe(),
    prompt: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type RunInput = z.infer<typeof runInput>;
export const runStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "no_changes",
  "failed",
  "needs_attention",
]);
export type RunStatus = z.infer<typeof runStatus>;
export type Repository = { id: number; fullName: string; defaultBranch: string };
export type Run = {
  id: string;
  repository: Repository;
  prompt: string;
  status: RunStatus;
  stage: string;
  createdAt: string;
  updatedAt: string;
  pullRequest: { number: number; url: string } | null;
  summary: string | null;
  error: { code: string; message: string } | null;
};
export type RunEvent = { id: string; stage: string; message: string; createdAt: string };
export type Page<T> = { items: T[]; nextCursor: string | null };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createClient(baseUrl: string, token?: () => string | undefined) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    const bearer = token?.();
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      headers,
      credentials: "include",
    });
    const body = await response.json();
    if (!response.ok)
      throw new ApiError(
        response.status,
        body.error?.code ?? "request_failed",
        body.error?.message ?? "Request failed",
      );
    return body as T;
  }
  return {
    request,
    me: () => request<{ id: string; login: string }>("/api/v1/me"),
    repositories: (cursor = "") =>
      request<Page<Repository>>(`/api/v1/repositories?cursor=${encodeURIComponent(cursor)}`),
    createRun: (input: RunInput, key: string) =>
      request<Run>("/api/v1/runs", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "idempotency-key": key },
      }),
    runs: (cursor = "") => request<Page<Run>>(`/api/v1/runs?cursor=${encodeURIComponent(cursor)}`),
    run: (id: string) => request<Run>(`/api/v1/runs/${encodeURIComponent(id)}`),
    events: (id: string, after = "0") =>
      request<Page<RunEvent>>(
        `/api/v1/runs/${encodeURIComponent(id)}/events?after=${encodeURIComponent(after)}`,
      ),
  };
}
