// Loopback-only external-provider fixture. This is not Stripe sandbox coverage.
import { createServer } from "node:http";
import { z } from "zod";
const customers = new Map<string, { workspace: string }>();
const sessions = new Map<string, { id: string; url: string; status: string; customer: string }>();
const idempotency = new Map<string, { fingerprint: string; response: unknown }>();
const Fault = z.object({
  workspace: z.string(),
  path: z.enum(["/v1/customers", "/v1/checkout/sessions", "/v1/subscriptions"]),
  kind: z.enum(["timeout_after_success", "error"]),
  remaining: z.number().int().min(1).max(3),
});
const faults: z.infer<typeof Fault>[] = [];
const states = new Map<string, { status: string; paid: boolean; price: string }>();
const requests: { path: string; body: Record<string, string>; idempotencyKey?: string }[] = [];
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
    if (path === "/health") {
      res.end("ready");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    const respond = (value: unknown) => res.end(JSON.stringify(value));
    if (path === "/fault" && req.method === "POST") {
      faults.push(Fault.parse(JSON.parse(raw)));
      respond({ ok: true });
      return;
    }
    if (path === "/resources") {
      const ids = new Set(
        [...customers]
          .filter(([, c]) => c.workspace === url.searchParams.get("workspace"))
          .map(([id]) => id),
      );
      respond({
        customers: ids.size,
        sessions: [...sessions.values()].filter((s) => ids.has(s.customer)).length,
      });
      return;
    }
    if (path === "/control" && req.method === "POST") {
      const state = z
        .object({
          workspace: z.string(),
          status: z.string(),
          paid: z.boolean().default(true),
          price: z.string().default("price_local"),
        })
        .parse(JSON.parse(raw));
      const matching = [...customers].filter(([, c]) => c.workspace === state.workspace);
      if (matching.length > 1) throw new Error("Ambiguous customer mapping");
      const customer = matching[0]?.[0];
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
    const idempotencyKey = z.string().optional().parse(req.headers["idempotency-key"]);
    requests.push({ path, body: form, idempotencyKey });
    const customer = form.customer ?? url.searchParams.get("customer") ?? "";
    const workspace =
      path === "/v1/customers" ? form["metadata[workspace]"] : customers.get(customer)?.workspace;
    const fault = faults.find(
      (f) => f.remaining > 0 && f.path === path && f.workspace === workspace,
    );
    if (fault) fault.remaining--;
    if (fault?.kind === "error") {
      res.statusCode = 500;
      res.setHeader("stripe-should-retry", "false");
      respond({ error: { type: "api_error", message: "Fixture reconciliation failure" } });
      return;
    }
    const finish = (value: unknown) => {
      if (fault?.kind === "timeout_after_success") {
        // Exceed the real adapter's 10s timeout, including its automatic retry.
        const pending = setTimeout(() => respond(value), 15000);
        res.on("close", () => clearTimeout(pending));
      } else respond(value);
    };
    const mutate = (create: () => unknown) => {
      const fingerprint = JSON.stringify([req.method, path, Object.entries(form).sort()]);
      const previous = idempotencyKey ? idempotency.get(idempotencyKey) : undefined;
      if (previous && previous.fingerprint !== fingerprint) {
        res.statusCode = 400;
        respond({
          error: { type: "idempotency_error", message: "Key reused with different parameters" },
        });
        return;
      }
      const response = previous ? previous.response : create();
      if (idempotencyKey) idempotency.set(idempotencyKey, { fingerprint, response });
      finish(response);
    };
    if (path === "/v1/customers" && req.method === "POST") {
      const workspace = z.string().parse(form["metadata[workspace]"]);
      mutate(() => {
        const id = "cus_" + crypto.randomUUID();
        customers.set(id, { workspace });
        return { id, object: "customer", livemode: false };
      });
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
      mutate(() => {
        const session = {
          id: "cs_" + crypto.randomUUID(),
          url: "http://127.0.0.1:8792/checkout",
          status: "open",
          customer: z.string().parse(form.customer),
        };
        sessions.set(session.id, session);
        return session;
      });
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
