import { test, expect } from "@playwright/test";
import { mock } from "node:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { z } from "zod";
import worker from "../../src/worker";
import { testEnv } from "../../scripts/test-env";

test("ChatGPT OIDC exchanges PKCE for an ID-token-only response and rejects invalid identity tokens", async () => {
  const issuer = "https://auth.openai.com",
    clientId = "local-openai-client";
  const keys = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "local-key", alg: "RS256", use: "sig" };
  let nonce = "",
    challenge = "",
    failure = "",
    confidential = false;
  const original = globalThis.fetch;
  const mocked = mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin !== issuer) return original(input, init);
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          authorization_endpoint: issuer + "/api/accounts/authorize",
          token_endpoint: issuer + "/api/accounts/oauth/token",
          jwks_uri: issuer + "/.well-known/jwks.json",
          id_token_signing_alg_values_supported: ["RS256"],
        });
      if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [jwk] });
      if (url.pathname === "/api/accounts/oauth/token") {
        const body = new URLSearchParams(
          typeof init?.body === "string"
            ? init.body
            : init?.body instanceof URLSearchParams
              ? init.body
              : "",
        );
        const verifier = body.get("code_verifier");
        expect(verifier).toBeTruthy();
        const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier ?? ""),
        );
        expect(Buffer.from(hash).toString("base64url")).toBe(challenge);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          confidential
            ? "Basic " + Buffer.from(clientId + ":local-secret").toString("base64")
            : null,
        );
        const token = await new SignJWT({
          email: "oidc-" + crypto.randomUUID() + "@example.test",
          email_verified: true,
          name: "OIDC user",
          nonce: failure === "nonce" ? "wrong" : nonce,
        })
          .setProtectedHeader({
            alg: "RS256",
            kid: failure === "signature" ? "unknown-key" : "local-key",
          })
          .setIssuer(failure === "issuer" ? "https://wrong.example" : issuer)
          .setAudience(failure === "audience" ? "wrong" : clientId)
          .setSubject(crypto.randomUUID())
          .setIssuedAt()
          .setExpirationTime(failure === "expired" ? "-1h" : "5m")
          .sign(keys.privateKey);
        return Response.json({ id_token: token, token_type: "Bearer" });
      }
      throw new Error("Unexpected identity provider request");
    },
  );
  try {
    for (const variant of [
      "public",
      "confidential",
      "nonce",
      "issuer",
      "audience",
      "expired",
      "signature",
    ]) {
      failure = variant;
      confidential = variant === "confidential";
      const env = {
        ...testEnv(),
        OPENAI_CLIENT_ID: clientId,
        ...(confidential ? { OPENAI_CLIENT_SECRET: "local-secret" } : {}),
        ASSETS: { fetch: async () => new Response("") },
      };
      const start = await worker.fetch(
        new Request("http://localhost:8790/api/auth/sign-in/social", {
          method: "POST",
          headers: {
            origin: "http://localhost:8790",
            "content-type": "application/json",
            "cf-connecting-ip":
              "2001:db8:" +
              crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)?.join(":"),
          },
          body: JSON.stringify({ provider: "chatgpt", callbackURL: "/", disableRedirect: true }),
        }),
        env,
      );
      expect(start.status).toBe(200);
      const authorize = new URL(z.object({ url: z.url() }).parse(await start.json()).url);
      nonce = authorize.searchParams.get("nonce") ?? "";
      challenge = authorize.searchParams.get("code_challenge") ?? "";
      expect(nonce).not.toBe("");
      expect(challenge).not.toBe("");
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      const cookies = start.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const callback =
        "http://localhost:8790/api/auth/callback/chatgpt?code=local-code&state=" +
        encodeURIComponent(authorize.searchParams.get("state") ?? "");
      const response = await worker.fetch(
        new Request(callback, { headers: { cookie: cookies } }),
        env,
      );
      const session = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const account = await worker.fetch(
        new Request("http://localhost:8790/api/account", { headers: { cookie: session } }),
        env,
      );
      expect(account.status).toBe(["public", "confidential"].includes(variant) ? 200 : 401);
      const replay = await worker.fetch(
        new Request(callback, { headers: { cookie: cookies } }),
        env,
      );
      expect(
        replay.headers
          .getSetCookie()
          .some((value) => value.startsWith("better-auth.session_token=")),
      ).toBe(false);
    }
  } finally {
    mocked.mock.restore();
  }
});
