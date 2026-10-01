# Onboarding coverage and remaining gaps

| Gap | Implementation work possible without live credentials | Live prerequisite |
| --- | --- | --- |
| Email identities can start company onboarding | Authenticate identity independently of workspace authorization; persist identity and show setup | Verified email sender domain/API key |
| Self-service company setup | Bound DNS challenge, proof verification, atomic new-tenant creation, explicit domain enablement; never reclaim existing tenants | Company administrator controls DNS TXT record |
| Workspace administrator controls | Member list, promotion/demotion/suspension with last-admin guard; explicit enabled-domain settings and audit | None |
| Self-service GitHub connection | Session-bound GitHub App user OAuth, prove installation and org-admin/personal-owner authority, short-lived repository selection proposal, atomic grants | GitHub App OAuth client/secret, installation |
| Missed review/CI webhooks require redelivery | Provider-history reconciliation remains a reliability enhancement; signed persisted deliveries already retry | No credentials needed to implement; live contract smoke needed |
| Docker/Codex/Git private-repo path not live-tested | Existing production adapters and fake-adapter tests; actual provider behavior requires approved smoke test | Daytona Linux VM snapshot, provider keys, approved test repo |
| Billing collection missing | Not required for agreed scope; existing status/quota controls remain | None |
| Production scale/operations hardening | Retention, global spending limits, load testing and alerts remain separate from functional onboarding | Operational requirements and approved environment |

The first four rows are implemented and locally tested.

Security invariants: a stable Better Auth user ID is identity; a consumed magic link verifies mailbox control. Company membership additionally requires independently DNS-proven, admin-enabled domains. Merely being the first employee does not confer administrator rights. Only a DNS-proven claimant may create a new company workspace, and the domain starts disabled until that administrator explicitly enables autojoin. Existing domains/workspaces cannot be claimed or reassigned through onboarding. GitHub workspace-admin status alone does not prove authority over a GitHub installation; require provider-verified org-admin or personal-owner authority and explicit repository selection. All OAuth state is expiring, session/user/workspace bound and single use. Provider tokens remain server-side and transient.
