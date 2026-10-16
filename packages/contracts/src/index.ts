import { z } from "zod";
export const githubPermissionsMessage =
  "Update the GitHub App installation permissions: Contents, Pull requests, and Workflows write, plus Checks, Commit statuses, and Actions read are required";
export const projectState = z.enum([
  "queued",
  "running",
  "paused",
  "awaiting_review",
  "completed",
  "cancelled",
  "failed",
  "needs_attention",
]);
export const projectName = z
  .string()
  .trim()
  .min(1)
  .refine((name) => Array.from(name).length <= 120, "Name must be at most 120 characters");
export const projectRename = z.object({ name: projectName }).strict();
export const projectPrompt = z.string().trim().min(1).max(8000);
export const projectPromptEdit = z.object({ prompt: projectPrompt }).strict();
export const projectModel = z.string().trim().min(1).max(200);
export const reasoningEffort = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(40);
export const projectInput = z
  .object({
    name: z
      .string()
      .trim()
      .transform((name) => name || undefined)
      .pipe(projectName.optional())
      .optional(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    prompt: projectPrompt,
    model: projectModel.default("gpt-6-luna"),
    reasoningEffort: reasoningEffort.default("low"),
    maxWip: z.number().int().min(1).max(2147483647).default(1),
  })
  .strict();
export const projectUpdate = z
  .object({
    name: projectName.optional(),
    prompt: projectPrompt.optional(),
    model: projectModel.optional(),
    reasoningEffort: reasoningEffort.optional(),
    maxWip: projectInput.shape.maxWip.removeDefault().optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((value) => value !== undefined),
    "Provide at least one project setting",
  );
export type ProjectUpdate = z.infer<typeof projectUpdate>;
export const pullRequestMetadataSchema = z.object({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  checksPassed: z.boolean().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
});
export const pullRequestSchema = pullRequestMetadataSchema.extend({
  url: z.string().url(),
  number: z.number().int(),
  state: z.enum(["open", "merged", "closed"]),
  branch: z.string(),
  headSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  baseSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  patchSha: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const ciRepairSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(["running", "waiting", "completed", "failed"]),
  canRetry: z.boolean(),
});
export const attemptSchema = z.object({
  ciRepair: ciRepairSchema.nullable().optional(),
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
export const projectSchema = projectInput.extend({
  name: projectName,
  id: z.string().uuid(),
  ownerId: z.string(),
  state: projectState,
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
  projectId: z.string().uuid(),
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
export type Project = z.infer<typeof projectSchema>;
export type ProjectInput = z.input<typeof projectInput>;
export type ProjectEvent = z.infer<typeof eventSchema>;
export type Session = z.infer<typeof sessionSchema>;
export const repositoryDiscoverySchema = z.object({
  repositories: z.array(repositorySchema),
  permissionsRequired: z.boolean(),
});
export type RepositoryDiscovery = z.infer<typeof repositoryDiscoverySchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type ProjectAction = z.infer<typeof actionSchema>;

export const streamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("projects"), projects: z.array(projectSchema) }),
  z.object({
    type: z.literal("events"),
    projectId: z.string().uuid(),
    events: z.array(eventSchema),
  }),
]);
