import { z } from "zod";
import { auth } from "./auth";
import { database } from "./database";
import type { Env } from "./env";
import { Account, Workspace, WorkspaceList, CreateWorkspace, Configuration } from "./contracts";
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function route(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/health") return Response.json({ ok: true });
  if (path === "/api/config")
    return Response.json(
      Configuration.parse({
        providers: [
          ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? ["google"] : []),
          ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? ["github"] : []),
          ...(env.OPENAI_CLIENT_ID ? ["chatgpt"] : []),
        ],
        billingEnabled: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID),
      }),
    );
  if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);
  if (!["GET", "HEAD"].includes(req.method) && req.headers.get("origin") !== env.APP_ORIGIN)
    throw new HttpError(403, "Origin rejected");
  const pool = database(env.DATABASE_URL);
  try {
    const identity = auth(env, pool);
    if (path.startsWith("/api/auth/")) {
      const enabled = new Set([
        "/api/auth/sign-up/email",
        "/api/auth/sign-in/email",
        "/api/auth/verify-email",
        "/api/auth/get-session",
        "/api/auth/sign-out",
      ]);
      if (!enabled.has(path)) throw new HttpError(404, "Not found");
      return await identity.handler(req);
    }
    const session = await identity.api.getSession({ headers: req.headers });
    if (!session) throw new HttpError(401, "Sign in required");
    if (!session.user.emailVerified) throw new HttpError(403, "Verify your email first");
    if (path === "/api/account" && req.method === "GET")
      return Response.json(
        Account.parse({
          ...session.user,
          twoFactorEnabled: session.user.twoFactorEnabled ?? false,
        }),
      );
    if (path === "/api/workspaces" && req.method === "GET") {
      const result = await pool.query<{ id: string; name: string; role: string }>(
        'SELECT o.id,o.name,m.role FROM subscription_auth.organization o JOIN subscription_auth.member m ON m."organizationId"=o.id WHERE m."userId"=$1 ORDER BY o."createdAt",o.id',
        [session.user.id],
      );
      return Response.json(WorkspaceList.parse(result.rows));
    }
    if (path === "/api/workspaces" && req.method === "POST") {
      const input = CreateWorkspace.parse(await req.json());
      const created = await identity.api.createOrganization({
        headers: req.headers,
        body: { name: input.name, slug: crypto.randomUUID() },
      });
      if (!created) throw new HttpError(500, "Workspace creation failed");
      return Response.json(Workspace.parse({ id: created.id, name: created.name, role: "owner" }), {
        status: 201,
      });
    }
    throw new HttpError(404, "Not found");
  } finally {
    await pool.end();
  }
}
export default {
  async fetch(req: Request, env: Env) {
    let response: Response;
    try {
      response = await route(req, env);
    } catch (error) {
      const status =
        error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
      response = Response.json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : status === 400
                ? "Invalid request"
                : "Request failed",
        },
        { status },
      );
    }
    const result = new Response(response.body, response);
    result.headers.set("Cache-Control", "no-store");
    result.headers.set("X-Content-Type-Options", "nosniff");
    result.headers.set("Referrer-Policy", "no-referrer");
    result.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return result;
  },
};
