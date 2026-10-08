import { z } from 'zod';
import { goalInput } from '@herbie/contracts';
export const draftSchema = z.object({repository:z.string(),prompt:z.string(),test:z.string(),maxAttempts:z.string(),requestId:z.string().uuid()});
export type Draft = z.infer<typeof draftSchema>;
export function newDraft(repository = ''): Draft { return {repository,prompt:'',test:'["npm", "test"]',maxAttempts:'1',requestId:crypto.randomUUID()}; }
export function parseDraft(draft: Draft) {
  let testCommand: unknown;
  try { testCommand = JSON.parse(draft.test); } catch { throw new Error('Test command must be a JSON array, for example ["npm", "test"].'); }
  const input = goalInput.safeParse({repository:draft.repository,prompt:draft.prompt,testCommand,maxAttempts:Number(draft.maxAttempts)});
  if (!input.success) throw new Error(input.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
  return input.data;
}
