import { z } from "zod";
import { ApiError, runInput } from "@prompt-to-pr/contracts";
import type { Store } from "./store.js";
import type { Identity } from "./auth.js";
import { GitHubError, type GitHub } from "./github.js";

const uuid = z.string().uuid();
const cursorSchema = z.object({ createdAt: z.string().datetime(), id: uuid });
const authMethods = new Map([
  ["/sign-in/social", "POST"],
  ["/sign-out", "POST"],
  ["/get-session", "GET"],
  ["/callback/github", "GET"],
  ["/device/code", "POST"],
  ["/device/token", "POST"],
  ["/device/approve", "POST"],
  ["/device/deny", "POST"],
]);

export function createHandler(
  store: Store,
  auth: Pick<Identity, "session" | "userToken"> & {
    identity: { handler(request: Request): Promise<Response> };
  },
  github: Pick<GitHub, "repositories" | "authorize">,
  config: { PUBLIC_URL: string; GITHUB_APP_SLUG: string },
) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/api/live" && request.method === "GET") return Response.json({ ok: true });
      if (path === "/api/health" && request.method === "GET") {
        await store.pool.query("SELECT 1");
        return Response.json({
          ok: true,
          deploymentId: process.env.DEPLOYMENT_ID ?? "development",
        });
      }
      if (path === "/api/auth/callback" && request.method === "GET") {
        url.pathname = "/api/auth/callback/github";
        return auth.identity.handler(new Request(url, request));
      }
      if (path === "/api/auth/installation/callback" && request.method === "GET") {
        await auth.session(request.headers);
        // The legacy setup URL is retained. Callback parameters grant no repository access.
        return Response.redirect(`${config.PUBLIC_URL}/`, 303);
      }
      // Cookie mutations require the exact origin. Device/token requests are unauthenticated
      // and protected by unguessable device codes; Better Auth handles its own CSRF rules.
      if (
        request.method !== "GET" &&
        request.headers.has("cookie") &&
        request.headers.get("origin") !== config.PUBLIC_URL
      )
        throw new ApiError(403, "invalid_origin", "Request origin is not allowed");
      if (path.startsWith("/api/auth/")) {
        const suffix = path.slice("/api/auth".length);
        if (authMethods.get(suffix) !== request.method)
          throw new ApiError(404, "not_found", "Endpoint not found");
        if (suffix === "/device/approve" || suffix === "/device/deny") {
          await auth.session(request.headers);
          const { userCode } = z
            .object({ userCode: z.string().min(1).max(30) })
            .parse(await request.clone().json());
          const verified = await auth.identity.handler(
            new Request(
              `${config.PUBLIC_URL}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
              { headers: request.headers },
            ),
          );
          if (!verified.ok) return verified;
        }
        return auth.identity.handler(request);
      }
      const user = await auth.session(request.headers);
      if (path === "/api/v1/me" && request.method === "GET") return Response.json(user);
      if (path === "/api/v1/installation" && request.method === "POST") {
        // GitHub returns to the app without granting authority through callback parameters.
        // Repository discovery always independently checks user + App access after return.
        return Response.json({
          url: `https://github.com/apps/${config.GITHUB_APP_SLUG}/installations/new`,
        });
      }
      if (path === "/api/v1/repositories" && request.method === "GET") {
        const after = z.coerce
          .number()
          .int()
          .min(0)
          .safe()
          .parse(url.searchParams.get("cursor") || "0");
        const repos = (await github.repositories(await auth.userToken(user.id))).filter(
          (repo) => repo.id > after,
        );
        const items = repos
          .slice(0, 50)
          .map(({ id, fullName, defaultBranch }) => ({ id, fullName, defaultBranch }));
        return Response.json({
          items,
          nextCursor: repos.length > 50 ? String(items.at(-1)!.id) : null,
        });
      }
      if (path === "/api/v1/runs" && request.method === "POST") {
        const key = uuid.parse(request.headers.get("idempotency-key"));
        const input = runInput.parse(await request.json());
        const authorized = await github.authorize(
          await auth.userToken(user.id),
          input.repositoryId,
        );
        const { installationId, ...repository } = authorized;
        const run = await store.create(user.id, input, key, repository, installationId);
        return Response.json(run, { status: 202, headers: { location: `/api/v1/runs/${run.id}` } });
      }
      if (path === "/api/v1/runs" && request.method === "GET") {
        let cursor;
        if (url.searchParams.get("cursor")) {
          try {
            cursor = cursorSchema.parse(
              JSON.parse(
                Buffer.from(url.searchParams.get("cursor")!, "base64url").toString("utf8"),
              ),
            );
          } catch {
            throw new ApiError(400, "invalid_cursor", "Invalid page cursor");
          }
        }
        return Response.json(await store.list(user.id, cursor));
      }
      const match = /^\/api\/v1\/runs\/([^/]+)(\/events)?$/.exec(path);
      if (match && request.method === "GET") {
        const id = uuid.parse(match[1]);
        if (match[2]) {
          const after = z
            .string()
            .regex(/^\d{1,18}$/)
            .parse(url.searchParams.get("after") || "0");
          return Response.json(await store.events(user.id, id, after));
        }
        return Response.json(await store.get(user.id, id));
      }
      throw new ApiError(404, "not_found", "Endpoint not found");
    } catch (error) {
      if (error instanceof ApiError)
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status },
        );
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return Response.json(
          { error: { code: "invalid_request", message: "Check the request fields and try again" } },
          { status: 400 },
        );
      if (error instanceof GitHubError)
        return Response.json(
          {
            error: {
              code: "github_unavailable",
              message: "GitHub access failed; reconnect or try again later",
            },
          },
          { status: 502 },
        );
      console.error(JSON.stringify({ code: "request_failed" }));
      return Response.json(
        { error: { code: "request_failed", message: "Request failed; try again later" } },
        { status: 500 },
      );
    }
  };
}
