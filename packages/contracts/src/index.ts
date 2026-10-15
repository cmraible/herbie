import { z } from "zod";
export const goalState = z.enum([
  "queued",
  "running",
  "paused",
  "awaiting_review",
  "completed",
  "cancelled",
  "failed",
  "needs_attention",
]);
export const goalName = z
  .string()
  .trim()
  .min(1)
  .refine((name) => Array.from(name).length <= 120, "Name must be at most 120 characters");
export const goalRename = z.object({ name: goalName }).strict();
export const goalPrompt = z.string().trim().min(1).max(8000);
export const goalPromptEdit = z.object({ prompt: goalPrompt }).strict();
export const goalInput = z
  .object({
    name: z
      .string()
      .trim()
      .transform((name) => name || undefined)
      .pipe(goalName.optional())
      .optional(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    prompt: goalPrompt,
    maxWip: z.number().int().min(1).max(2147483647).default(1),
  })
  .strict();
export const goalUpdate = z
  .object({
    name: goalName.optional(),
    prompt: goalPrompt.optional(),
    maxWip: goalInput.shape.maxWip.removeDefault().optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((value) => value !== undefined),
    "Provide at least one goal setting",
  );
export type GoalUpdate = z.infer<typeof goalUpdate>;
export const pullRequestSchema = z.object({
  url: z.string().url(),
  number: z.number().int(),
  state: z.enum(["open", "merged", "closed"]),
  branch: z.string(),
  headSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
});
export const attemptSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive(),
  state: z.enum([
    "queued",
    "running",
    "ready",
    "publishing",
    "awaiting_review",
    "completed",
    "cancelled",
    "failed",
    "needs_attention",
  ]),
  createdAt: z.string(),
  pullRequest: pullRequestSchema.nullable(),
});
export type Attempt = z.infer<typeof attemptSchema>;
export const goalSchema = goalInput.extend({
  name: goalName,
  id: z.string().uuid(),
  ownerId: z.string(),
  state: goalState,
  attemptCount: z.number().int(),
  attempts: z.array(attemptSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mode: z.enum(["demo", "live"]),
  stopRequested: z.enum(["pause", "cancel"]).nullable(),
  pullRequest: pullRequestSchema.nullable(),
  pullRequests: z.array(pullRequestSchema).default([]),
  cleanupStatus: z
    .enum(["not_required", "pending", "complete", "needs_attention"])
    .default("not_required"),
  error: z.string().nullable(),
});
export const eventSchema = z.object({
  attemptId: z.string().uuid().nullable().optional(),
  id: z.number().int(),
  goalId: z.string().uuid(),
  type: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
export const sessionSchema = z.object({
  user: z.object({ id: z.string(), login: z.string() }),
  mode: z.literal("live"),
});
export const repositorySchema = z.object({
  fullName: z.string(),
  defaultBranch: z.string(),
  installationId: z.number().int(),
});
export const authStartSchema = z.object({
  url: z.string().url(),
  pollToken: z.string().optional(),
  userCode: z
    .string()
    .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    .optional(),
});
export const installationStartSchema = z.object({ url: z.string().url() });
export const authPollSchema = z.object({
  status: z.enum(["pending", "complete", "expired", "rejected"]),
  token: z.string().optional(),
});
export const actionSchema = z.enum(["pause", "resume", "cancel"]);
export type Goal = z.infer<typeof goalSchema>;
export type GoalInput = z.input<typeof goalInput>;
export type GoalEvent = z.infer<typeof eventSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type GoalAction = z.infer<typeof actionSchema>;
