import { test, expect } from "@playwright/test";
import { register, createWorkspace } from "./helpers";
import { z } from "zod";

test("Stripe fixture deduplicates by idempotency key, not workspace metadata", async ({
  request,
}) => {
  const workspace = crypto.randomUUID();
  const create = async (key?: string, value: string = workspace) => {
    const response = await request.post("http://127.0.0.1:8792/v1/customers", {
      headers: key ? { "Idempotency-Key": key } : {},
      form: { "metadata[workspace]": value },
    });
    return response;
  };
  const key = crypto.randomUUID();
  const identity = async (response: Awaited<ReturnType<typeof create>>) =>
    z.object({ id: z.string() }).parse(await response.json()).id;
  const original = await identity(await create(key));
  expect(await identity(await create(key))).toBe(original);
  expect(await identity(await create(crypto.randomUUID()))).not.toBe(original);
  expect(await identity(await create())).not.toBe(await identity(await create()));
  expect((await create(key, "changed-" + workspace)).status()).toBe(400);
});

for (const operation of ["customers", "checkout/sessions"]) {
  test(`checkout recovers after ${operation} succeeds but both responses time out`, async ({
    page,
  }) => {
    test.setTimeout(65000);
    const { WorkspaceList, Redirect } = await import("../../src/contracts");
    await register(page, "Recovery owner");
    await createWorkspace(page, "Recovery team");
    const workspace = WorkspaceList.parse(
      await (await page.request.get("/api/workspaces")).json(),
    )[0];
    if (!workspace) throw new Error("Missing workspace");
    const path = `/api/workspaces/${workspace.id}/billing/checkout`;
    const headers = { origin: "http://localhost:8790" };
    expect(
      (
        await page.request.post("http://127.0.0.1:8792/fault", {
          data: {
            workspace: workspace.id,
            path: "/v1/" + operation,
            kind: "timeout_after_success",
            remaining: 2,
          },
        })
      ).status(),
    ).toBe(200);
    expect((await page.request.post(path, { headers, data: {}, timeout: 50000 })).status()).toBe(
      500,
    );
    if (operation === "customers") {
      const { mock } = await import("node:test");
      const { default: worker } = await import("../../src/worker");
      const { testEnv } = await import("../../scripts/test-env");
      const cookie = (await page.context().cookies())
        .map((item) => `${item.name}=${item.value}`)
        .join("; ");
      mock.timers.enable({ apis: ["Date"], now: Date.now() + 24 * 3600000 });
      try {
        const stale = await worker.fetch(
          new Request("http://localhost:8790" + path, {
            method: "POST",
            headers: { ...headers, cookie, "Content-Type": "application/json" },
            body: "{}",
          }),
          { ...testEnv(), ASSETS: { fetch: async () => new Response("") } },
        );
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({
          error: "Uncertain billing operation requires operator reconciliation",
        });
      } finally {
        mock.timers.reset();
      }
    }
    const recovered = await page.request.post(path, { headers, data: {} });
    expect(recovered.status()).toBe(200);
    expect(Redirect.parse(await recovered.json()).url).toContain("/checkout");
    const state = z
      .object({ customers: z.number(), sessions: z.number() })
      .parse(
        await (
          await page.request.get("http://127.0.0.1:8792/resources?workspace=" + workspace.id)
        ).json(),
      );
    expect(state).toEqual({ customers: 1, sessions: 1 });
  });
}

test("workspace admins can open configured-plan checkout without redirect granting paid access", async ({
  page,
}) => {
  await register(page, "Billing owner");
  await createWorkspace(page, "Billing team");
  await expect(page.getByRole("button", { name: "Subscribe", exact: true })).toBeVisible();
  await expect(page.getByText("Paid access: no", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:8792\/checkout/);
  await page.goto("/?checkout=success");
  await expect(page.getByText("Paid access: no", { exact: true })).toBeVisible();
});

test("an expired Checkout requires reconciliation before a new session is created", async ({
  page,
}) => {
  const { WorkspaceList } = await import("../../src/contracts");
  await register(page, "Expired checkout owner");
  await createWorkspace(page, "Expired checkout team");
  const workspace = WorkspaceList.parse(
    await (await page.request.get("/api/workspaces")).json(),
  )[0];
  if (!workspace) throw new Error("Missing workspace");
  const base = `/api/workspaces/${workspace.id}/billing`;
  const options = { headers: { origin: "http://localhost:8790" }, data: {} };
  expect((await page.request.post(base + "/checkout", options)).status()).toBe(200);
  expect(
    (
      await page.request.post("http://127.0.0.1:8792/control", {
        data: { workspace: workspace.id, status: "canceled", checkoutStatus: "expired" },
      })
    ).status(),
  ).toBe(200);
  expect((await page.request.post(base + "/checkout", options)).status()).toBe(409);
  expect((await page.request.post(base + "/refresh", options)).status()).toBe(200);
  expect((await page.request.post(base + "/checkout", options)).status()).toBe(200);
  expect(
    await (
      await page.request.get("http://127.0.0.1:8792/resources?workspace=" + workspace.id)
    ).json(),
  ).toEqual({ customers: 1, sessions: 2 });
});

test("signed webhooks grant and revoke access from current Stripe state, safely replaying delayed events", async ({
  page,
  browser,
}) => {
  const { WorkspaceList, Billing } = await import("../../src/contracts");
  const { emailLink } = await import("./helpers");
  const { default: Stripe } = await import("stripe");
  const { z } = await import("zod");
  await register(page, "Subscriber");
  await createWorkspace(page, "Subscription team");
  const workspace = WorkspaceList.parse(
    await (await page.request.get("/api/workspaces")).json(),
  )[0];
  if (!workspace) throw new Error("Workspace absent");
  const base = `/api/workspaces/${workspace.id}/billing`;
  const headers = { origin: "http://localhost:8790" };
  const checkout = await Promise.all([
    page.request.post(base + "/checkout", { headers, data: {} }),
    page.request.post(base + "/checkout", { headers, data: {} }),
  ]);
  expect(checkout.map((r) => r.status())).toEqual([200, 200]);
  expect(
    await (
      await page.request.get("http://127.0.0.1:8792/resources?workspace=" + workspace.id)
    ).json(),
  ).toEqual({ customers: 1, sessions: 1 });
  const control = async (status: string, paid = true, price = "price_local") => {
    const response = await page.request.post("http://127.0.0.1:8792/control", {
      data: { workspace: workspace.id, status, paid, price },
    });
    return z.object({ customer: z.string() }).parse(await response.json()).customer;
  };
  const customer = await control("active");
  const payload = (id: string, type = "customer.subscription.updated") =>
    JSON.stringify({
      id,
      type,
      livemode: false,
      data: { object: { customer, status: "active" } },
    });
  const stripe = new Stripe("sk_test_local_only");
  const deliver = (data: string, signature?: string) =>
    page.request.post("/api/billing/webhook", {
      headers: {
        "stripe-signature":
          signature ??
          stripe.webhooks.generateTestHeaderString({ payload: data, secret: "whsec_local_only" }),
      },
      data,
    });
  expect((await deliver(payload("evt_bad"), "bad")).status()).toBe(400);
  expect(Billing.parse(await (await page.request.get(base)).json()).entitled).toBe(false);
  const event = payload("evt_" + crypto.randomUUID());
  expect(
    (
      await page.request.post("http://127.0.0.1:8792/fault", {
        data: { workspace: workspace.id, path: "/v1/subscriptions", kind: "error", remaining: 1 },
      })
    ).status(),
  ).toBe(200);
  expect((await deliver(event)).status()).toBe(500);
  expect(Billing.parse(await (await page.request.get(base)).json()).entitled).toBe(false);
  // The failed reconciliation must roll back the receipt so the same delivery can recover.
  const deliveries = await Promise.all([deliver(event), deliver(event)]);
  expect(deliveries.map((r) => r.status())).toEqual([200, 200]);
  await page.reload();
  await expect(page.getByText("Paid access: yes", { exact: true })).toBeVisible();
  expect((await page.request.post(base + "/checkout", { headers, data: {} })).status()).toBe(409);
  await page.getByRole("button", { name: "Manage billing", exact: true }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:8792\/portal/);
  await page.goto("/");
  await control("canceled");
  // Event body still claims active; canonical state is canceled.
  expect((await deliver(payload("evt_" + crypto.randomUUID()))).status()).toBe(200);
  expect((await deliver(event)).status()).toBe(200);
  expect(Billing.parse(await (await page.request.get(base)).json()).entitled).toBe(false);
  await control("active", false);
  for (const status of ["past_due", "unpaid", "paused"]) {
    await control(status, false);
    expect(
      (await deliver(payload("evt_" + crypto.randomUUID(), "invoice.payment_failed"))).status(),
    ).toBe(200);
    expect(Billing.parse(await (await page.request.get(base)).json()).entitled).toBe(false);
  }
  await control("active", false);
  expect((await page.request.post(base + "/refresh", { headers, data: {} })).status()).toBe(200);
  expect(Billing.parse(await (await page.request.get(base)).json()).entitled).toBe(false);
  await control("active", true, "price_other");
  await page.request.post(base + "/refresh", { headers, data: {} });
  expect(Billing.parse(await (await page.request.get(base)).json()).entitled).toBe(false);
  const context = await browser.newContext();
  const member = await context.newPage();
  try {
    const email = await register(member, "Billing member");
    await page.getByLabel("Invite email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Send invitation", exact: true }).click();
    await member.goto(await emailLink(member, email, "Workspace invitation"));
    await member.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect(
      member.getByRole("heading", { name: "Subscription team", exact: true }),
    ).toBeVisible();
    for (const action of ["checkout", "portal", "refresh"])
      expect((await member.request.post(base + "/" + action, { headers, data: {} })).status()).toBe(
        403,
      );
    await expect(member.getByRole("button", { name: "Subscribe", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("cached entitlement fails closed after configuration changes or webhook removal", async ({
  page,
}) => {
  const { default: worker } = await import("../../src/worker");
  const { Billing, WorkspaceList } = await import("../../src/contracts");
  await register(page, "Scope owner");
  await createWorkspace(page, "Scope team");
  const workspace = WorkspaceList.parse(
    await (await page.request.get("/api/workspaces")).json(),
  )[0];
  if (!workspace) throw new Error("Missing workspace");
  const path = `/api/workspaces/${workspace.id}/billing`;
  await page.request.post(path + "/checkout", {
    headers: { origin: "http://localhost:8790" },
    data: {},
  });
  await page.request.post("http://127.0.0.1:8792/control", {
    data: { workspace: workspace.id, status: "active" },
  });
  await page.request.post(path + "/refresh", {
    headers: { origin: "http://localhost:8790" },
    data: {},
  });
  expect(Billing.parse(await (await page.request.get(path)).json()).entitled).toBe(true);
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const env = {
    APP_ORIGIN: "http://localhost:8790",
    DATABASE_URL:
      process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55433/postgres",
    BETTER_AUTH_SECRET: "local-only-subscription-test-secret-32-characters",
    ASSETS: { fetch: async () => new Response("") },
    STRIPE_SECRET_KEY: "sk_test_local_only",
    STRIPE_WEBHOOK_SECRET: "whsec_local_only",
    STRIPE_PRICE_ID: "price_local",
    BILLING_MODE: "test",
  };
  for (const change of [
    { STRIPE_PRICE_ID: "price_changed" },
    { BILLING_MODE: "live" },
    { STRIPE_SECRET_KEY: "sk_test_other_account" },
    { STRIPE_WEBHOOK_SECRET: "" },
  ]) {
    const response = await worker.fetch(
      new Request("http://localhost:8790" + path, { headers: { cookie } }),
      { ...env, ...change },
    );
    expect(response.status).toBe(200);
    expect(Billing.parse(await response.json())).toMatchObject({ entitled: false, enabled: false });
  }
});
