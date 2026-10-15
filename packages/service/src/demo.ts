import { createHash } from 'node:crypto';
import type { Adapters } from './adapters.js';
import { KnownAttemptFailure } from './adapters.js';

// This deterministic adapter never calls GitHub, Daytona, a model, or host Git.
export function createDemoAdapters(): Adapters {
  return {
    mode:'demo',
    async repositories() { return [{fullName:'demo/example',defaultBranch:'main',installationId:0}]; },
    async authorize(_userId,repository) {
      if (repository !== 'demo/example') throw new Error('Demo supports only demo/example');
      return {repository,defaultBranch:'main',installationId:0};
    },
    async reconciliationRepository(repository) {
      if (repository !== 'demo/example') throw new Error('Demo supports only demo/example');
      return {repository,defaultBranch:'main',installationId:0};
    },
    async attempt(execution,report) {
      await report('DEMO: deterministic attempt started; no sandbox or model was used.');
      if (execution.goal.prompt.includes('[demo:fail]')) throw new KnownAttemptFailure('DEMO: requested simulated attempt failure; no publication occurred.');
      const patch = Buffer.from('DEMO artifact; never eligible for live publication.');
      await report('DEMO: simulated attempt completed.');
      return {baseCommit:'0'.repeat(40),patch};
    },
    async publish(execution,_changes,requireLease) {
      await requireLease();
      const number = Number.parseInt(createHash('sha256').update(execution.attemptId).digest('hex').slice(0,7),16);
      return {url:`https://demo.invalid/herbie/pull/${number}`,number,branch:execution.branch};
    },
    async reconcile(execution) {
      return execution.goal.pullRequests.find(pr => pr.branch === execution.branch) ?? null;
    },
  };
}

export function demoGoalName(prompt:string):string {
  return Array.from(prompt.replaceAll('[demo:fail]', '').trim()).slice(0,120).join('').trim() || 'Demo goal';
}
