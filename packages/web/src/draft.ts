import { z } from 'zod';
import { goalInput } from '@herbie/contracts';
export const draftSchema = z.object({repository:z.string(),name:z.string().default(''),prompt:z.string(),maxAttempts:z.string(),requestId:z.string().uuid()});
export type Draft = z.infer<typeof draftSchema>;
export function newDraft(repository = ''): Draft { return {repository,name:'',prompt:'',maxAttempts:'1',requestId:crypto.randomUUID()}; }
export function parseDraft(draft: Draft) {
  const input = goalInput.safeParse({repository:draft.repository,...(draft.name.trim() ? {name:draft.name} : {}),prompt:draft.prompt,maxAttempts:Number(draft.maxAttempts)});
  if (!input.success) throw new Error(input.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
  return input.data;
}
