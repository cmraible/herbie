# Onboarding coverage and remaining gaps

| Gap | Implementation work possible without live credentials | Live prerequisite |
| --- | --- | --- |
| Email identities can create private workspaces | Authenticate identity independently of workspace authorization; persist identity and show setup | Verified email sender domain/API key |
| Self-service private setup | Atomic identity-bound creation receipt; retries cannot duplicate a workspace or restore revoked access; no company-domain claim | None |
| Workspace administrator controls | Member list, promotion/demotion/suspension with last-admin guard; audit; domain-based autojoin disabled | None |
| Self-service GitHub connection | Session-bound GitHub App user OAuth, prove installation and org-admin/personal-owner authority, short-lived repository selection proposal, atomic grants | GitHub App OAuth client/secret, installation |
| Missed review/CI webhooks require redelivery | Provider-history reconciliation remains a reliability enhancement; signed persisted deliveries already retry | No credentials needed to implement; live contract smoke needed |
| Docker/Codex/Git private-repo path not live-tested | Existing production adapters and fake-adapter tests; actual provider behavior requires approved smoke test | Daytona Linux VM snapshot, provider keys, approved test repo |
| Billing collection missing | Not required for agreed scope; existing status/quota controls remain | None |
| Production scale/operations hardening | Retention, global spending limits, load testing and alerts remain separate from functional onboarding | Operational requirements and approved environment |

The first four rows are implemented and locally tested.

Security invariants: a stable Better Auth user ID is identity; a consumed magic link verifies mailbox control. An admitted, signed-in user can create a private workspace. Matching email domains confer no membership or company-domain ownership, including legacy enabled domains. Existing workspaces, members and historical domain/challenge data are preserved. Pending DNS setup is ignored; refreshing shows the private creation form. Creation receipts ensure repeated/concurrent requests return one workspace without granting access again after suspension, deletion or demotion of membership. No self-service invitation flow is included in this milestone; existing member administration remains available. GitHub workspace-admin status alone does not prove authority over a GitHub installation; require provider-verified org-admin or personal-owner authority and explicit repository selection. All OAuth state is expiring, session/user/workspace bound and single use. Provider tokens remain server-side and transient.
