import { HttpError } from '../adapters/auth.js';
import { D1Goals } from '../adapters/d1.js';
import { change } from '../core/ports.js';
import { feedback } from '../core/model.js';
import type { AppEnv } from './env.js';
import { bytes } from './http.js';
import { github } from './services.js';
export async function verifySignature(secret: string, body: Uint8Array, signature: string) {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const digest = Uint8Array.from(signature.slice(7).match(/../g)!, x => parseInt(x, 16));
  return crypto.subtle.verify('HMAC', key, digest, body as Uint8Array<ArrayBuffer>);
}
interface Payload {
  action?: string; installation?: { id: number }; repository?: { full_name: string };
  pull_request?: { number: number }; issue?: { number: number; pull_request?: object };
  comment?: { body: string; html_url?: string }; review?: { body: string; state: string };
  check_run?: { name: string; conclusion: string; head_sha: string; details_url?: string };
  workflow_run?: { name: string; conclusion: string; head_sha: string; html_url?: string };
  sender?: { type?: string };
}
export async function receiveWebhook(req: Request, env: AppEnv) {
  const raw = await bytes(req);
  if (!await verifySignature(env.GITHUB_WEBHOOK_SECRET, raw, req.headers.get('x-hub-signature-256') ?? '')) throw new HttpError(401, 'Invalid webhook signature');
  const id = req.headers.get('x-github-delivery'), event = req.headers.get('x-github-event');
  if (!id || !/^[\w-]{1,100}$/.test(id) || !event) throw new HttpError(400, 'Invalid webhook delivery');
  const body = new TextDecoder().decode(raw);
  try { JSON.parse(body); } catch { throw new HttpError(400, 'Invalid webhook JSON'); }
  await env.DB.prepare('INSERT OR IGNORE INTO deliveries(id,received,body,event) VALUES(?,?,?,?)').bind(id, Date.now(), body, event).run();
  return id;
}
export async function processDelivery(env: AppEnv, id: string) {
  const row = await env.DB.prepare('SELECT body,event FROM deliveries WHERE id=? AND completed=0').bind(id).first<{ body: string; event: string }>();
  if (!row) return;
  const p = JSON.parse(row.body) as Payload;
  if (typeof p.repository?.full_name === 'string' && Number.isSafeInteger(p.installation?.id)) {
    const match = await env.DB.prepare('SELECT workspace FROM repositories WHERE installation=? AND repo=? AND enabled=1')
      .bind(p.installation!.id, p.repository.full_name).first<{ workspace: string }>();
    if (match) {
      const store = new D1Goals(env.DB);
      for (const goal of (await store.list(match.workspace)).filter(g => g.repo === p.repository!.full_name)) {
        const prNumber = p.pull_request?.number ?? (p.issue?.pull_request ? p.issue.number : undefined);
        // A review/check can arrive between GitHub publication and its D1 checkpoint.
        // Keep the inbox pending until the publication reservation is reconciled.
        if (goal.runs.some(r => r.status === 'publishing') && !goal.prs.some(pr => pr.number === prNumber)) {
          await env.GOALS.getByName(goal.id).wake(goal.id);
          throw new Error('Publication still reconciling');
        }
        const ci = p.check_run ?? p.workflow_run;
        for (const known of goal.prs.filter(pr => pr.state === 'open' && (!prNumber || pr.number === prNumber))) {
          const provider = await github(env, goal.workspace, goal.repo);
          const actual = await provider.inspect(goal.repo, known.number);
          let message: string | undefined;
          if (actual.state === 'open' && prNumber && p.sender?.type !== 'Bot') {
            if (['pull_request_review_comment', 'issue_comment'].includes(row.event) && p.action === 'created') message = p.comment?.body;
            if (row.event === 'pull_request_review' && p.action === 'submitted' && p.review?.state === 'changes_requested') message = p.review.body || 'Review requested changes';
          }
          if (actual.state === 'open' && ['check_run', 'workflow_run'].includes(row.event) && p.action === 'completed' &&
              ci && ['failure', 'timed_out', 'action_required'].includes(ci.conclusion) && ci.head_sha === actual.head) {
            message = `Fix failing CI ${ci.name} on commit ${ci.head_sha}. Reproduce the failure and run the relevant tests.`;
          }
          if (typeof message === 'string' && message.trim()) await change(store, goal.id, g => feedback(g, `${id}:${known.number}`, known.number, message!));
        }
        await env.GOALS.getByName(goal.id).wake(goal.id);
      }
    }
  }
  await env.DB.prepare('UPDATE deliveries SET completed=1 WHERE id=?').bind(id).run();
}
