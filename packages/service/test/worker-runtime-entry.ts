import pg from "pg";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return Response.json({ postgresPoolAvailable: typeof pg.Pool === "function" });
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
