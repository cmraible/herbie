// Loopback-only external-provider fixture. This is not Stripe sandbox coverage.
import { createServer } from "node:http";
import { z } from "zod";
const customers = new Map<string, string>();
const sessions = new Map<string, { id: string; url: string; status: string; customer: string }>();
const states = new Map<string, { status: string; paid: boolean; price: string }>();
const requests: { path: string; body: Record<string, string> }[] = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:8792");
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Invalid body");
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString();
    const form = Object.fromEntries(new URLSearchParams(raw));
    const path = url.pathname;
    res.setHeader("Content-Type", "application/json");
    const respond = (value: unknown) => res.end(JSON.stringify(value));
    if (path === "/control" && req.method === "POST") {
      const state = z
        .object({
          workspace: z.string(),
          status: z.string(),
          paid: z.boolean().default(true),
          price: z.string().default("price_local"),
        })
        .parse(JSON.parse(raw));
      const customer = customers.get(state.workspace);
      if (!customer) {
        res.statusCode = 404;
        respond({ error: "No customer" });
        return;
      }
      states.set(customer, state);
      respond({ customer });
      return;
    }
    if (path === "/requests") {
      respond(requests);
      return;
    }
    requests.push({ path, body: form });
    if (path === "/v1/customers" && req.method === "POST") {
      const workspace = z.string().parse(form["metadata[workspace]"]);
      const id = customers.get(workspace) ?? "cus_" + crypto.randomUUID();
      customers.set(workspace, id);
      respond({ id, object: "customer", livemode: false });
      return;
    }
    if (path === "/v1/subscriptions") {
      const customer = url.searchParams.get("customer") ?? "",
        state = states.get(customer);
      respond({
        object: "list",
        has_more: false,
        data: state
          ? [
              {
                id: "sub_local",
                customer,
                status: state.status,
                livemode: false,
                items: { data: [{ price: { id: state.price } }] },
                latest_invoice: { status: state.paid ? "paid" : "open" },
              },
            ]
          : [],
      });
      return;
    }
    if (path === "/v1/checkout/sessions" && req.method === "POST") {
      const attempt = z.string().parse(req.headers["idempotency-key"]);
      const session = sessions.get(attempt) ?? {
        id: "cs_" + crypto.randomUUID(),
        url: "http://127.0.0.1:8792/checkout",
        status: "open",
        customer: form.customer ?? "",
      };
      sessions.set(attempt, session);
      respond(session);
      return;
    }
    if (path.startsWith("/v1/checkout/sessions/")) {
      respond([...sessions.values()].find((s) => s.id === path.split("/").at(-1)));
      return;
    }
    if (path === "/v1/billing_portal/sessions") {
      respond({ url: "http://127.0.0.1:8792/portal" });
      return;
    }
    if (["/checkout", "/portal"].includes(path)) {
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<!doctype html><title>External billing fixture</title><h1>External billing fixture</h1>",
      );
      return;
    }
    res.statusCode = 404;
    respond({ error: "Unknown fixture endpoint" });
  } catch {
    res.statusCode = 400;
    res.end('{"error":"Invalid fixture input"}');
  }
});
server.listen(8792, "127.0.0.1");
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
