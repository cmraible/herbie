import { writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import { betterAuth } from "better-auth";
import { openAPI } from "better-auth/plugins";
import SwaggerParser from "@apidevtools/swagger-parser";
import { authOptions } from "../src/auth";
import { authPaths } from "../src/auth-routes";
import { database } from "../src/database";
import { endpoints } from "../src/api-contract";
import { ErrorBody } from "../src/contracts";
// Schema generation never connects to a database or needs provider credentials.
const pool = database("postgresql://postgres:postgres@127.0.0.1:55432/postgres");
try {
  const options = authOptions(
    {
      APP_ORIGIN: "https://example.com",
      BETTER_AUTH_SECRET: "schema-generation-only-not-a-runtime-secret",
      DATABASE_URL: "unused",
    },
    pool,
  );
  const identity = betterAuth({
    ...options,
    database: undefined,
    plugins: [...options.plugins, openAPI({ disableDefaultReference: true })],
  });
  const generated = z
    .object({
      paths: z.record(z.string(), z.unknown()),
      components: z.record(z.string(), z.unknown()),
    })
    .parse(await identity.api.generateOpenAPISchema());
  const paths: Record<string, unknown> = {};
  const anonymous = new Set([
    "/sign-in/social",
    "/sign-in/email",
    "/sign-up/email",
    "/verify-email",
    "/request-password-reset",
    "/reset-password",
    "/reset-password/{token}",
    "/passkey/generate-authenticate-options",
    "/passkey/verify-authentication",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
  ]);
  for (const [path, value] of Object.entries(generated.paths)) {
    const candidates =
      path === "/callback/{id}"
        ? ["/callback/google", "/callback/github", "/callback/chatgpt"]
        : [path];
    for (const candidate of candidates) {
      const full = "/api/auth" + candidate;
      if (!authPaths.includes(full) && candidate !== "/reset-password/{token}") continue;
      const operations = z.record(z.string(), z.unknown()).parse(value);
      const normalized: Record<string, unknown> = {};
      for (const [method, raw] of Object.entries(operations)) {
        if (!["get", "post", "patch", "delete", "put"].includes(method)) continue;
        const operation = z.record(z.string(), z.unknown()).parse(raw);
        const parameters = z
          .array(z.record(z.string(), z.unknown()))
          .parse(operation.parameters ?? [])
          .filter((p) => !(candidate.startsWith("/callback/") && p.in === "path"));
        normalized[method] = {
          ...operation,
          operationId: method + full.replaceAll(/[^a-zA-Z0-9]/g, "_"),
          parameters,
          security:
            anonymous.has(candidate) || candidate.startsWith("/callback/") ? [] : [{ session: [] }],
        };
      }
      paths[full] = normalized;
    }
  }
  for (const endpoint of endpoints) {
    const operation = {
      summary: endpoint.summary,
      security: endpoint.public ? [] : [{ session: [] }],
      parameters: [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      ...(endpoint.input
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: z.toJSONSchema(endpoint.input, { io: "input", unrepresentable: "any" }),
                },
              },
            },
          }
        : {}),
      responses: {
        [endpoint.status ?? 200]: {
          description: "Success",
          content: { "application/json": { schema: z.toJSONSchema(endpoint.output) } },
        },
        default: {
          description: "Request rejected or dependency unavailable",
          content: { "application/json": { schema: z.toJSONSchema(ErrorBody) } },
        },
      },
    };
    const existing = z.record(z.string(), z.unknown()).parse(paths[endpoint.path] ?? {});
    paths[endpoint.path] = { ...existing, [endpoint.method]: operation };
  }
  const document = {
    openapi: "3.1.0",
    info: {
      title: "Subscription template",
      version: "0.1.0",
      description:
        "Cookie authenticated API. All user mutations require an exact APP_ORIGIN Origin header. OAuth callbacks use state; Stripe webhooks require signed raw payloads. Only documented auth endpoints are exposed.",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      ...generated.components,
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "__Secure-better-auth.session_token" },
      },
    },
  };
  await mkdir("docs", { recursive: true });
  await writeFile("docs/openapi.json", JSON.stringify(document, null, 2) + "\n");
  await SwaggerParser.validate("docs/openapi.json");
  console.log("Generated and validated OpenAPI contract");
} finally {
  await pool.end();
}
