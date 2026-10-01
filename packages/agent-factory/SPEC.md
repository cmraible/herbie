# Agent factory milestone contract

Source: the user's delegated agent-factory request in this task. This package is new work in cmraible/herbie; preserve the root controller and pnpm.

- Hosted multi-user app with server-verified Google identity (`sub`, verified email, `hd`); automatic membership only for operator-verified/enabled company domains. The first employee never gains ownership. All members can view/edit/manage all workspace goals; connections/secrets/billing restricted to admins/operators.
- Editable freeform goal, repository, outstanding PR target default 1. Snapshot each run's prompt version. Start promptly, and verified merges replenish incremental work. Repair review comments and CI failures. Close without merge pauses. Bound retries and escalate.
- Generated PRs must make review lightweight: solve one small problem or make one small improvement, aim for a couple of lines where practical without a hard line cap, avoid bundled fixes, and use proportionate verification. PR title/summary should primarily describe the concrete problem the commit solves. This constrains generated PRs, not the initial product implementation.
- Ordinary TypeScript core with storage/repository/execution interfaces; Cloudflare Workers/D1/goal Durable Objects, Daytona dedicated Linux VM per job attempt, Codex executor. Actual Docker builds, container runs and Compose test stacks must work. No host Docker socket or provider master keys in customer code.
- Persist reservations counting pending creation plus open PRs. Signed, idempotent webhook inbox; serial PR work; tolerate delayed/duplicate events, crash recovery, stopped processes and VM loss. Keep checkpoints outside VMs.
- Small goals list/detail/activity/settings interface. Document setup, current official provider contracts, tested evidence and live validation gaps. Explicit hosted OpenAI API authentication, no assumed ChatGPT subscription funding.
- This task authorizes implementation and local tests, not deployment, credential creation, purchases, external PRs, merges or autonomous execution against live repositories. Default FACTORY_ENABLED=false.

This is a reviewable first milestone, not a claim of production readiness. Operator-assisted tenant/domain and GitHub installation onboarding and billing status/quota foundations are included. Self-service proof of domain ownership, GitHub installation onboarding, payment collection and metered billing are remaining product work; they must not bypass the operator verification gates.
