import pg from "pg";
import { betterAuth } from "better-auth";
import { Daytona } from "@daytona/sdk";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === "/crypto") {
      const encoder = new TextEncoder();
      const message = encoder.encode("herbie-workers-crypto-compatibility");
      const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, message);
      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, encrypted);

      const signingKey = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        false,
        ["sign", "verify"],
      );
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        signingKey.privateKey,
        message,
      );
      const signatureValid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        signingKey.publicKey,
        signature,
        message,
      );

      return Response.json({
        credentialRoundTrip:
          new TextDecoder().decode(decrypted) === new TextDecoder().decode(message),
        signatureValid,
      });
    }

    if (request.method === "GET") {
      return Response.json({
        postgresPoolAvailable: typeof pg.Pool === "function",
        betterAuthAvailable: typeof betterAuth === "function",
        daytonaAvailable: typeof Daytona === "function",
      });
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const input = new Uint8Array(await request.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", input);
    const bytes = Array.from(new Uint8Array(digest));
    return Response.json({
      digest: bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    });
  },
};
