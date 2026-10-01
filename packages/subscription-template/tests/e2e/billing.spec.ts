import { test, expect } from "@playwright/test";
import { register, createWorkspace } from "./helpers";

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
  const control = async (status: string, paid = true, price = "price_local") => {
    const response = await page.request.post("http://127.0.0.1:8792/control", {
      data: { workspace: workspace.id, status, paid, price },
    });
    return z.object({ customer: z.string() }).parse(await response.json()).customer;
  };
  const customer = await control("active");
  const payload = (id: string) =>
    JSON.stringify({
      id,
      type: "customer.subscription.updated",
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
