import type { Run } from './model.js';
/** Product policy for generated PRs, independent of executor/provider. */
export function executionPrompt(run: Run) {
  return [
    'Read repository instructions first. Make exactly one small, focused improvement toward the goal.',
    'PR review must be lightweight: aim for a couple of lines of code when practical. This is a preference, not a numeric line cap.',
    'Solve only one problem. Do not bundle adjacent fixes, opportunistic cleanup, or broad refactors. If the goal is broad or a checklist, choose one small next step.',
    'Use the smallest sufficient change and proportionate verification. Run relevant existing tests; add a test only when it meaningfully verifies the specific problem.',
    'Use real Docker/Compose development stacks when the chosen change requires them.',
    'Do not commit, merge, create PRs or push; the runner will checkpoint your changes. Do not change the Git remote or access credentials.',
    'Your final response must be JSON with string fields problem, change, and verification. Lead with the concrete problem this commit solves; keep change and verification brief.',
    'Goal (context, not a request to complete every part in this PR):', run.prompt,
    'Queued review/CI feedback (address only the existing PR problem):', ...run.feedback,
  ].join('\n\n');
}
export interface ChangeSummary { problem: string; change: string; verification: string }
export function changeSummary(value: unknown): ChangeSummary {
  if (!value || typeof value !== 'object') throw new Error('Missing change summary');
  const v = value as Record<string, unknown>;
  for (const key of ['problem', 'change', 'verification']) if (typeof v[key] !== 'string' || !v[key].trim() || v[key].length > 2000) throw new Error('Invalid change summary');
  return { problem: v.problem as string, change: v.change as string, verification: v.verification as string };
}
