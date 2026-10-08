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
      if (execution.goal.prompt.includes('[demo:fail]')) throw new KnownAttemptFailure('DEMO: requested simulated test failure; no publication occurred.');
      const patch = Buffer.from('DEMO artifact; never eligible for live publication.');
      await report('DEMO: simulated tests passed.');
      return {baseCommit:'0'.repeat(40),patch,testResult:{exitCode:0,stdout:'DEMO: simulated test result',stderr:''}};
    },
    async publish(execution,_changes,requireLease) {
      await requireLease();
      const number = Number.parseInt(createHash('sha256').update(execution.attemptId).digest('hex').slice(0,7),16);
      return {url:`https://demo.invalid/herbie/pull/${number}`,number,branch:execution.branch};
    },
    async reconcile(execution) {
      return execution.goal.pullRequest?.branch===execution.branch ? execution.goal.pullRequest : null;
    },
  };
}
