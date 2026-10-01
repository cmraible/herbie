import Stripe from "stripe";
import { z } from "zod";
import type { Env } from "./env";
import { HttpError } from "./http";
export const SubscriptionState = z.enum([
  "none",
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);
export type Subscription = { status: z.infer<typeof SubscriptionState>; entitled: boolean };
export interface Payments {
  customer(workspace: string): Promise<string>;
  checkout(customer: string, attempt: string): Promise<{ id: string; url: string }>;
  checkoutStatus(id: string): Promise<{ open: boolean; url: string | null }>;
  portal(customer: string): Promise<string>;
  subscription(customer: string): Promise<Subscription>;
  event(payload: string, signature: string): Promise<{ id: string; customer?: string }>;
}
export function billingEnabled(env: Env) {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID && env.STRIPE_WEBHOOK_SECRET);
}
export function payments(env: Env): Payments {
  if (!billingEnabled(env)) throw new HttpError(503, "Billing is not configured");
  const mode = z.enum(["test", "live"]).parse(env.BILLING_MODE ?? "test");
  const key = z.string().parse(env.STRIPE_SECRET_KEY);
  if (!key.startsWith("sk_" + mode + "_") && !key.startsWith("rk_" + mode + "_"))
    throw new Error("Stripe key mode mismatch");
  const local =
    env.APP_ORIGIN === "http://localhost:8790" &&
    mode === "test" &&
    env.STRIPE_API_URL === "http://127.0.0.1:8792";
  if (env.STRIPE_API_URL && !local) throw new Error("Custom Stripe endpoint is local-test only");
  const stripe = new Stripe(key, {
    apiVersion: "2026-09-30.endive",
    httpClient: Stripe.createFetchHttpClient(),
    timeout: 10000,
    maxNetworkRetries: 1,
    telemetry: false,
    ...(local ? { host: "127.0.0.1", port: 8792, protocol: "http" } : {}),
  });
  const price = z.string().parse(env.STRIPE_PRICE_ID);
  function url(value: unknown) {
    const address = z.url().parse(value),
      parsed = new URL(address);
    if (local && parsed.origin === "http://127.0.0.1:8792") return address;
    if (
      parsed.protocol !== "https:" ||
      !["checkout.stripe.com", "billing.stripe.com"].includes(parsed.hostname)
    )
      throw new Error("Unexpected Stripe redirect");
    return address;
  }
  return {
    async customer(workspace) {
      const result = await stripe.customers.create(
        { metadata: { workspace } },
        { idempotencyKey: "workspace-customer-" + workspace },
      );
      if (result.livemode !== (mode === "live")) throw new Error("Stripe customer mode mismatch");
      return z.string().parse(result.id);
    },
    async checkout(customer, attempt) {
      const result = await stripe.checkout.sessions.create(
        {
          customer,
          mode: "subscription",
          line_items: [{ price, quantity: 1 }],
          success_url: env.APP_ORIGIN + "/?checkout=success",
          cancel_url: env.APP_ORIGIN + "/?checkout=canceled",
        },
        { idempotencyKey: "checkout-" + attempt },
      );
      return { id: result.id, url: url(result.url) };
    },
    async checkoutStatus(id) {
      const result = await stripe.checkout.sessions.retrieve(id);
      return { open: result.status === "open", url: result.url ? url(result.url) : null };
    },
    async portal(customer) {
      return url(
        (await stripe.billingPortal.sessions.create({ customer, return_url: env.APP_ORIGIN })).url,
      );
    },
    async subscription(customer) {
      const result = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
        expand: ["data.latest_invoice"],
      });
      if (result.has_more)
        throw new Error("Subscription reconciliation requires operator attention");
      const subscriptions = result.data.filter((s) =>
        s.items.data.some((item) => item.price.id === price),
      );
      const current =
        subscriptions.find((s) => s.status === "active" || s.status === "trialing") ??
        subscriptions.find((s) => !["canceled", "incomplete_expired"].includes(s.status)) ??
        subscriptions[0];
      if (!current) return { status: "none", entitled: false };
      if (current.livemode !== (mode === "live"))
        throw new Error("Stripe subscription mode mismatch");
      const paid =
        current.latest_invoice !== null &&
        typeof current.latest_invoice !== "string" &&
        current.latest_invoice.status === "paid";
      return {
        status: SubscriptionState.parse(current.status),
        entitled: current.status === "trialing" || (current.status === "active" && paid),
      };
    },
    async event(payload, signature) {
      let verified: unknown;
      try {
        verified = await stripe.webhooks.constructEventAsync(
          payload,
          signature,
          z.string().parse(env.STRIPE_WEBHOOK_SECRET),
          300,
          Stripe.createSubtleCryptoProvider(),
        );
      } catch {
        throw new HttpError(400, "Invalid webhook signature");
      }
      const event = z
        .object({
          id: z.string(),
          type: z.string(),
          livemode: z.boolean(),
          data: z.object({ object: z.unknown() }),
        })
        .parse(verified);
      if (event.livemode !== (mode === "live")) throw new HttpError(400, "Webhook mode mismatch");
      const relevant =
        event.type.startsWith("customer.subscription.") ||
        ["checkout.session.completed", "invoice.paid", "invoice.payment_failed"].includes(
          event.type,
        );
      if (!relevant) return { id: event.id };
      const object = z.object({ customer: z.string() }).parse(event.data.object);
      return { id: event.id, customer: object.customer };
    },
  };
}
// Key fingerprint also fences accidental account changes. Key rotation requires explicit reconciliation.
export async function billingScope(env: Env) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(env.STRIPE_SECRET_KEY ?? ""),
  );
  const fingerprint = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [env.BILLING_MODE ?? "test", env.STRIPE_PRICE_ID ?? "", fingerprint].join(":");
}
