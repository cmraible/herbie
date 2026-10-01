import { afterEach, expect, test, vi } from "vitest";
import { payments } from "../../src/payments";
import { testEnv } from "../../scripts/test-env";
const env = { ...testEnv(), ASSETS: { fetch: async () => new Response("") } };
afterEach(() => vi.unstubAllGlobals());
function provider(response: unknown) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe("http://127.0.0.1:8792");
    return Response.json(response);
  });
  return payments(env);
}
test("billing refuses truncated subscriptions or a customer/subscription from the wrong payment mode", async () => {
  await expect(provider({ data: [], has_more: true }).subscription("cus_fixture")).rejects.toThrow(
    "operator attention",
  );
  await expect(
    provider({ id: "cus_wrong", livemode: true }).customer("workspace_fixture"),
  ).rejects.toThrow("customer mode mismatch");
  await expect(
    provider({
      has_more: false,
      data: [
        {
          status: "active",
          livemode: true,
          latest_invoice: { status: "paid" },
          items: { data: [{ price: { id: "price_local" } }] },
        },
      ],
    }).subscription("cus_fixture"),
  ).rejects.toThrow("subscription mode mismatch");
});
test("an unexpanded or absent latest invoice cannot grant active access; explicit trials can", async () => {
  for (const latest_invoice of [null, "in_fixture", { status: "open" }]) {
    const result = await provider({
      has_more: false,
      data: [
        {
          status: "active",
          livemode: false,
          latest_invoice,
          items: { data: [{ price: { id: "price_local" } }] },
        },
      ],
    }).subscription("cus_fixture");
    expect(result).toEqual({ status: "active", entitled: false });
  }
  expect(
    await provider({
      has_more: false,
      data: [
        {
          status: "trialing",
          livemode: false,
          latest_invoice: null,
          items: { data: [{ price: { id: "price_local" } }] },
        },
      ],
    }).subscription("cus_fixture"),
  ).toEqual({ status: "trialing", entitled: true });
});
test("Checkout and Portal reject unexpected redirect destinations from the external provider", async () => {
  for (const url of [
    "https://attacker.test/pay",
    "http://checkout.stripe.com/pay",
    "javascript:alert(1)",
  ]) {
    const gateway = provider({ id: "cs_fixture", url });
    await expect(gateway.checkout("cus_fixture", "attempt_fixture")).rejects.toThrow();
    await expect(gateway.portal("cus_fixture")).rejects.toThrow();
  }
});
test("provider configuration cannot route hosted credentials to a custom test endpoint", () => {
  expect(() => payments({ ...env, APP_ORIGIN: "https://app.example.test" })).toThrow(
    "local-test only",
  );
  expect(() => payments({ ...env, BILLING_MODE: "live" })).toThrow("mode mismatch");
});
