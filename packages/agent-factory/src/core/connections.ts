export interface RepositoryGrant { repo: string; installation: number; account: string }
export interface GitHubAuthorization {
  authorizationUrl(state: string, challenge: string): string;
  repositories(code: string, verifier: string): Promise<RepositoryGrant[]>;
}
