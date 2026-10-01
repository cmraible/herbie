import { test, expect } from "vitest";
import { z } from "zod";
import document from "../../docs/openapi.json" with { type: "json" };
import { enabledAuthPath } from "../../src/auth-routes";
test("documented authentication schemes resolve and callbacks match the public allowlist", () => {
  const paths = z.record(z.string(), z.record(z.string(), z.unknown())).parse(document.paths);
  const schemes = z.record(z.string(), z.unknown()).parse(document.components.securitySchemes);
  for (const [path, methods] of Object.entries(paths)) {
    if (path.startsWith("/api/auth/callback/")) expect(enabledAuthPath(path)).toBe(true);
    for (const raw of Object.values(methods)) {
      const operation = z
        .object({ security: z.array(z.record(z.string(), z.array(z.string()))).optional() })
        .parse(raw);
      for (const requirement of operation.security ?? [])
        for (const scheme of Object.keys(requirement)) expect(schemes[scheme]).toBeDefined();
    }
  }
  expect(document.paths["/api/auth/sign-in/email"].post.security).toEqual([]);
  expect(document.paths["/api/auth/sign-up/email"].post.security).toEqual([]);
});
