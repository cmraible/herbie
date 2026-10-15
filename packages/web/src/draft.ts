import { z } from 'zod';
import { goalInput } from '@herbie/contracts';
export const draftSchema = z.object({repository:z.string(),name:z.string().default(''),prompt:z.string(),requestId:z.string().uuid()});
export type Draft = z.infer<typeof draftSchema>;
export function newDraft(repository = ''): Draft { return {repository,name:'',prompt:'',requestId:crypto.randomUUID()}; }
export function parseDraft(draft: Draft) {
  const input = goalInput.safeParse({repository:draft.repository,...(draft.name.trim() ? {name:draft.name} : {}),prompt:draft.prompt});
  if (!input.success) throw new Error(input.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
  return input.data;
}
