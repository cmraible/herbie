export interface CompanyIdentity { sub: string; domain: string; name: string; email: string }
export interface DomainChallenge { id: string; sub: string; domain: string; workspace: string; name: string; token: string; expires: number }
export interface CompanyStore {
  domainExists(domain: string): Promise<boolean>;
  challenge(sub: string, domain: string): Promise<DomainChallenge | undefined>;
  saveChallenge(challenge: DomainChallenge): Promise<void>;
  provision(challenge: DomainChallenge, now: number): Promise<void>;
}
export interface DomainProof { txt(name: string): Promise<string[]> }
export class OnboardingError extends Error {
  constructor(public code: 'conflict' | 'invalid' | 'pending' | 'expired', message: string) { super(message); }
}
export function companyDomain(value: string) {
  const domain = value.toLowerCase();
  if (domain.length > 253 || !domain.includes('.') || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new OnboardingError('invalid', 'Invalid company domain');
  return domain;
}
export function dnsRecord(c: DomainChallenge) { return { name: `_herbie-verification.${c.domain}`, type: 'TXT', value: `herbie-verification=${c.token}`, expires: c.expires }; }
export class CompanyOnboarding {
  constructor(private store: CompanyStore, private dns: DomainProof, private now = () => Date.now()) {}
  async begin(identity: CompanyIdentity, name: string) {
    const domain = companyDomain(identity.domain);
    if (await this.store.domainExists(domain)) throw new OnboardingError('conflict', 'Your company already has a workspace. Ask its administrator for access.');
    if (!name.trim() || name.length > 120) throw new OnboardingError('invalid', 'Company name must contain 1–120 characters');
    const previous = await this.store.challenge(identity.sub, domain);
    if (previous && previous.expires > this.now()) return dnsRecord(previous);
    const c: DomainChallenge = { id: crypto.randomUUID(), workspace: crypto.randomUUID(), sub: identity.sub, domain, name: name.trim(),
      token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''), expires: this.now() + 24 * 3600000 };
    await this.store.saveChallenge(c); return dnsRecord((await this.store.challenge(identity.sub,domain))!);
  }
  async verify(identity: CompanyIdentity) {
    const c = await this.store.challenge(identity.sub, companyDomain(identity.domain));
    if (!c || c.expires <= this.now()) throw new OnboardingError('expired', 'Verification request expired; start again');
    if (await this.store.domainExists(c.domain)) throw new OnboardingError('conflict', 'Company already registered; ownership cannot be reassigned here');
    const record = dnsRecord(c);
    if (!(await this.dns.txt(record.name)).includes(record.value)) throw new OnboardingError('pending', 'TXT record not found yet. Check the record and allow DNS propagation.');
    await this.store.provision(c, this.now());
    return { workspace: c.workspace, domain: c.domain, autojoinEnabled: false };
  }
}
