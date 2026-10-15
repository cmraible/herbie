import { z } from 'zod';
import { goalInput } from '@herbie/contracts';
// Preserve legacy names so retries keep the original idempotency payload.
export const draftSchema = z.object({repository:z.string(),name:z.string().optional(),prompt:z.string(),maxWip:z.string().default('1'),requestId:z.string().uuid()});
export type Draft = z.infer<typeof draftSchema>;
export function newDraft(repository = ''): Draft { return {repository,prompt:'',maxWip:'1',requestId:crypto.randomUUID()}; }
export function parseDraft(draft: Draft) {
  const input = goalInput.safeParse({repository:draft.repository,...(draft.name?.trim() ? {name:draft.name} : {}),prompt:draft.prompt,maxWip:Number(draft.maxWip)});
  if (!input.success) throw new Error(input.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
  return input.data;
}
