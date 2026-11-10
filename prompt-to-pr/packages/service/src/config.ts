import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_SCHEMA: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/)
    .default("prompt_to_pr"),
  DATABASE_CA: z.string().optional(),
  PUBLIC_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32),
  GITHUB_APP_ID: z.string().regex(/^\d+$/),
  GITHUB_APP_SLUG: z.string().regex(/^[\w-]+$/),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  ALLOWED_GITHUB_IDS: z.string().regex(/^\d+(,\d+)*$/),
  E2B_API_KEY: z.string().min(1).optional(),
  E2B_OPENAI_SECRET: z.string().min(1).optional(),
  E2B_TEMPLATE: z.string().min(1).optional(),
  AGENT_MODEL: z.string().min(1).default("gpt-6-luna"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});
export type Config = z.infer<typeof schema>;
export function configuration(): Config {
  const result = schema.safeParse(process.env);
  if (!result.success)
    throw new Error(
      `Missing or invalid configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  const url = new URL(result.data.PUBLIC_URL);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  )
    throw new Error("PUBLIC_URL must use HTTPS except for local development");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new Error("PUBLIC_URL must be an origin");
  result.data.PUBLIC_URL = url.origin;
  return result.data;
}
