import { Access } from '../adapters/auth.js';
import { GitHub } from '../adapters/github.js';
import type { AppEnv } from './env.js';
export async function github(env: AppEnv, workspace: string, repo: string) {
  const installation = await new Access(env.DB).repository(workspace, repo);
  return new GitHub(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installation);
}
