// Bindings/vars come from `pnpm types`; secret names are deliberately not in wrangler.jsonc.
export type AppEnv = Env & {
  GITHUB_APP_PRIVATE_KEY: string; GITHUB_WEBHOOK_SECRET: string; DAYTONA_API_KEY: string;
  OPENAI_API_KEY: string; RUN_TOKEN_SECRET: string;
};
