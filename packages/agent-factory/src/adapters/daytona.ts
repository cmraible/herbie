import { Daytona, DaytonaNotFoundError, SandboxClass, SandboxState } from '@daytona/sdk';
import { Buffer } from 'node:buffer';
import type { Execution, ExecutionResult } from '../core/ports.js';
import type { Goal, Run } from '../core/model.js';
import { runToken } from './capability.js';
export class DaytonaExecution implements Execution {
  private client: Daytona;
  constructor(private config: { apiKey: string; snapshot: string; origin: string; tokenSecret: string; model: string }) {
    this.client = new Daytona({ apiKey: config.apiKey, requestTimeoutMs: 15000 });
  }
  private name(run: Run) { return `herbie-${run.id}-${run.attempt}`; }
  private async get(run: Run) {
    try { return await this.client.get(this.name(run)); }
    catch (error) { if (error instanceof DaytonaNotFoundError) return undefined; throw error; }
  }
  async advance(goal: Goal, run: Run): Promise<ExecutionResult> {
    let vm = await this.get(run);
    if (!vm) {
      if (run.status !== 'queued') return { status: 'lost' };
      const snapshot = await this.client.snapshot.get(this.config.snapshot);
      if (snapshot.sandboxClass !== SandboxClass.LINUX_VM) throw new Error('A Linux VM snapshot is required');
      vm = await this.client.create({ name: this.name(run), snapshot: this.config.snapshot,
        public: false, autoStopInterval: 40, autoPauseInterval: 0, autoDeleteInterval: 0, ttlMinutes: 45,
        labels: { 'herbie-goal': goal.id, 'herbie-run': run.id, 'herbie-attempt': String(run.attempt) } }, { timeout: 20 });
    }
    if (vm.sandboxClass !== SandboxClass.LINUX_VM) throw new Error('Sandbox isolation mismatch');
    if (vm.state !== SandboxState.STARTED) return { status: 'lost' };
    const status = await vm.process.executeCommand('cat /tmp/herbie-result.json 2>/dev/null || true', undefined, undefined, 10);
    if (status.result.trim()) {
      const result = JSON.parse(status.result) as { status: string; checkpoint?: string };
      return result.status === 'succeeded' && /^[0-9a-f]{40,64}$/.test(result.checkpoint ?? '')
        ? { status: 'succeeded', checkpoint: result.checkpoint! } : { status: 'failed' };
    }
    // Repeated starts are guarded by flock and a durable started marker in the VM.
    // Only a scoped, expiring run capability enters the VM, never provider keys.
    const token = await runToken(this.config.tokenSecret, goal.id, run.id, run.attempt);
    await vm.fs.uploadFile(Buffer.from(JSON.stringify({ repo: goal.repo, branch: run.branch, prompt: run.prompt,
      feedback: run.feedback, kind: run.kind, origin: this.config.origin, token, model: this.config.model })), '/tmp/herbie-job.json', 10);
    const launch = await vm.process.executeCommand(
      'nohup flock -n /tmp/herbie.lock node /opt/herbie/runner.mjs >/tmp/herbie-runner.log 2>&1 </dev/null &', undefined, undefined, 10);
    if (launch.exitCode !== 0) return { status: 'failed' };
    return { status: 'running' };
  }
  async stop(_goal: Goal, run: Run) {
    const vm = await this.get(run);
    if (vm) await vm.delete(20, true);
  }
}
