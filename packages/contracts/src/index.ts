import { z } from 'zod';
export const goalState = z.enum(['queued', 'running', 'paused', 'awaiting_review', 'completed', 'cancelled', 'failed', 'needs_attention']);
export const goalInput = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  prompt: z.string().trim().min(1).max(8000),
  testCommand: z.array(z.string().min(1).max(1000).refine(s => !s.includes('\0'))).min(1).max(30),
  maxAttempts: z.number().int().min(1).max(5).default(1),
}).strict();
export const goalSchema = goalInput.extend({
  id: z.string().uuid(), ownerId: z.string(), state: goalState,
  attemptCount: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
  mode: z.enum(['demo', 'live']), stopRequested: z.enum(['pause', 'cancel']).nullable(),
  pullRequest: z.object({url:z.string().url(), number:z.number().int(), state:z.enum(['open','merged','closed']), branch:z.string()}).nullable(),
  error: z.string().nullable(),
});
export const eventSchema = z.object({id:z.number().int(), goalId:z.string().uuid(), type:z.string(), message:z.string(), createdAt:z.string()});
export const sessionSchema = z.object({user:z.object({id:z.string(),login:z.string()}),mode:z.enum(['demo','live'])});
export const repositorySchema = z.object({fullName:z.string(),defaultBranch:z.string(),installationId:z.number().int()});
export const authStartSchema = z.object({url:z.string().url(),pollToken:z.string().optional()});
export const authPollSchema = z.object({status:z.enum(['pending','complete','expired']),token:z.string().optional()});
export const actionSchema = z.enum(['pause','resume','cancel']);
export type Goal = z.infer<typeof goalSchema>;
export type GoalInput = z.infer<typeof goalInput>;
export type GoalEvent = z.infer<typeof eventSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type GoalAction = z.infer<typeof actionSchema>;
