import { z } from 'zod';
export const goalState = z.enum(['queued', 'running', 'paused', 'awaiting_review', 'completed', 'cancelled', 'failed', 'needs_attention']);
export const goalName = z.string().trim().min(1).refine(name => Array.from(name).length <= 120, 'Name must be at most 120 characters');
export const goalRename = z.object({name:goalName}).strict();
export const goalInput = z.object({
  name: goalName.optional(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  prompt: z.string().trim().min(1).max(8000),
  maxAttempts: z.number().int().min(1).max(5).default(1),
}).strict();
export const goalSchema = goalInput.extend({
  name: goalName,
  id: z.string().uuid(), ownerId: z.string(), state: goalState,
  attemptCount: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
  mode: z.enum(['demo', 'live']), stopRequested: z.enum(['pause', 'cancel']).nullable(),
  pullRequest: z.object({url:z.string().url(), number:z.number().int(), state:z.enum(['open','merged','closed']), branch:z.string()}).nullable(),
  cleanupStatus: z.enum(['not_required','pending','complete','needs_attention']).default('not_required'),
  error: z.string().nullable(),
});
export const eventSchema = z.object({id:z.number().int(), goalId:z.string().uuid(), type:z.string(), message:z.string(), createdAt:z.string()});
export const sessionSchema = z.object({user:z.object({id:z.string(),login:z.string()}),mode:z.enum(['demo','live'])});
export const repositorySchema = z.object({fullName:z.string(),defaultBranch:z.string(),installationId:z.number().int()});
export const authStartSchema = z.object({url:z.string().url(),pollToken:z.string().optional(),userCode:z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/).optional()});
export const installationStartSchema = z.object({url:z.string().url()});
export const authPollSchema = z.object({status:z.enum(['pending','complete','expired','rejected']),token:z.string().optional()});
export const actionSchema = z.enum(['pause','resume','cancel']);
export type Goal = z.infer<typeof goalSchema>;
export type GoalInput = z.infer<typeof goalInput>;
export type GoalEvent = z.infer<typeof eventSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type GoalAction = z.infer<typeof actionSchema>;
