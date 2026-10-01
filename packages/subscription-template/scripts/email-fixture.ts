// Test infrastructure only. Never included in the Worker bundle.
import { createServer } from "node:http";
import { z } from "zod";
const emails: { to: string[]; subject: string; text: string }[] = [];
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.end("ready");
      return;
    }
    if (req.method === "POST" && req.url === "/emails") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        if (!Buffer.isBuffer(chunk)) throw new Error("Invalid body");
        chunks.push(chunk);
      }
      const mail = z
        .object({ to: z.array(z.string()), subject: z.string(), text: z.string() })
        .parse(JSON.parse(Buffer.concat(chunks).toString()));
      emails.push(mail);
      res.setHeader("Content-Type", "application/json");
      res.end('{"id":"local-email"}');
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/emails?")) {
      const email = new URL(req.url, "http://localhost").searchParams.get("to");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(emails.filter((m) => m.to.includes(email ?? ""))));
      return;
    }
    res.statusCode = 404;
    res.end();
  } catch {
    res.statusCode = 400;
    res.end();
  }
});
server.listen(8791, "127.0.0.1");
console.log("Loopback test-only email sink ready");
process.on("SIGINT", () => server.close());
process.on("SIGTERM", () => server.close());
