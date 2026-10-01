import type { Pool, PoolClient } from "pg";
import type { Env } from "./env";
import { z } from "zod";
import { billingEnabled, billingScope, payments } from "./payments";
import { Billing, Redirect, Confirmation } from "./contracts";
import { membership, requireAdmin, transaction } from "./team";
import { HttpError, body } from "./http";
const Empty = z.object({}).strict();
type Reservation = {
  customer: string | null;
  checkout_attempt: string | null;
  checkout_id: string | null;
  scope: string;
  reserved_at: Date;
  attempt_at: Date | null;
};
async function locked(db: PoolClient, workspace: string, user: string, scope: string) {
  await db.query("SELECT id FROM subscription_auth.organization WHERE id=$1 FOR UPDATE", [
    workspace,
  ]);
  requireAdmin(await membership(db, user, workspace));
  const result = await db.query<Reservation>(
    "SELECT * FROM subscription_billing.workspace WHERE workspace=$1 FOR UPDATE",
    [workspace],
  );
  const row = result.rows[0];
  if (!row || row.scope !== scope)
    throw new HttpError(409, "Billing configuration changed; operator reconciliation required");
  return row;
}
function recoverable(start: Date | null) {
  if (!start || Date.now() - start.getTime() > 23 * 3600000)
    throw new HttpError(409, "Uncertain billing operation requires operator reconciliation");
}
export async function billingWebhook(req: Request, env: Env, pool: Pool) {
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  const provider = payments(env),
    scope = await billingScope(env);
  const event = await provider.event(await req.text(), req.headers.get("stripe-signature") ?? "");
  const customer = event.customer;
  if (!customer) return Response.json(Confirmation.parse({ ok: true }));
  await transaction(pool, async (db) => {
    const inserted = await db.query(
      "INSERT INTO subscription_billing.event(scope,id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id",
      [scope, event.id],
    );
    if (!inserted.rowCount) return;
    const result = await db.query<{ workspace: string }>(
      "SELECT workspace FROM subscription_billing.workspace WHERE customer=$1 AND scope=$2 FOR UPDATE",
      [customer, scope],
    );
    const row = result.rows[0];
    if (!row) return;
    const state = await provider.subscription(customer);
    await db.query(
      "UPDATE subscription_billing.workspace SET status=$1,entitled=$2,updated_at=now() WHERE workspace=$3",
      [state.status, state.entitled, row.workspace],
    );
  });
  return Response.json(Confirmation.parse({ ok: true }));
}
export async function billingRoute(
  req: Request,
  env: Env,
  pool: Pool,
  user: string,
): Promise<Response | undefined> {
  const match = /^\/api\/workspaces\/([^/]+)\/billing(?:\/(checkout|portal|refresh))?$/.exec(
    new URL(req.url).pathname,
  );
  if (!match) return;
  const workspace = z.string().parse(match[1]),
    action = match[2],
    scope = await billingScope(env);
  const role = await membership(pool, user, workspace);
  if (!action && req.method === "GET") {
    const result = await pool.query<{ status: string; entitled: boolean; scope: string }>(
      "SELECT status,entitled,scope FROM subscription_billing.workspace WHERE workspace=$1",
      [workspace],
    );
    const row = result.rows[0],
      matches = !row || row.scope === scope;
    return Response.json(
      Billing.parse({
        enabled: billingEnabled(env) && matches,
        ...(row && matches ? row : { status: "none", entitled: false }),
      }),
    );
  }
  if (req.method !== "POST" || !action) throw new HttpError(405, "Method not allowed");
  requireAdmin(role);
  await body(req, Empty);
  const provider = payments(env);
  // Persist reservations before provider mutations, so a process loss retains the original keys.
  await transaction(pool, async (db) => {
    await db.query("SELECT id FROM subscription_auth.organization WHERE id=$1 FOR UPDATE", [
      workspace,
    ]);
    requireAdmin(await membership(db, user, workspace));
    await db.query(
      "INSERT INTO subscription_billing.workspace(workspace,scope) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [workspace, scope],
    );
    const row = await locked(db, workspace, user, scope);
    if (action === "checkout" && !row.checkout_attempt)
      await db.query(
        "UPDATE subscription_billing.workspace SET checkout_attempt=$1,attempt_at=now() WHERE workspace=$2",
        [crypto.randomUUID(), workspace],
      );
  });
  // Commit customer mapping independently; downstream Checkout/Portal errors cannot roll it back.
  const customer = await transaction(pool, async (db) => {
    const row = await locked(db, workspace, user, scope);
    if (row.customer) return row.customer;
    recoverable(row.reserved_at);
    const customer = await provider.customer(workspace);
    await db.query("UPDATE subscription_billing.workspace SET customer=$1 WHERE workspace=$2", [
      customer,
      workspace,
    ]);
    return customer;
  });
  const result = await transaction(pool, async (db) => {
    const row = await locked(db, workspace, user, scope);
    if (action === "portal") return Redirect.parse({ url: await provider.portal(customer) });
    const current = await provider.subscription(customer);
    await db.query(
      "UPDATE subscription_billing.workspace SET status=$1,entitled=$2,updated_at=now() WHERE workspace=$3",
      [current.status, current.entitled, workspace],
    );
    const canStart = ["none", "canceled", "incomplete_expired"].includes(current.status);
    if (action === "refresh") {
      if (row.checkout_id && canStart && !(await provider.checkoutStatus(row.checkout_id)).open)
        await db.query(
          "UPDATE subscription_billing.workspace SET checkout_id=null,checkout_attempt=null,attempt_at=null WHERE workspace=$1",
          [workspace],
        );
      return Billing.parse({ enabled: true, ...current });
    }
    if (!canStart) return { error: "Manage the existing subscription in the billing portal" };
    if (row.checkout_id) {
      const session = await provider.checkoutStatus(row.checkout_id);
      if (session.open && session.url) return Redirect.parse({ url: session.url });
      return { error: "Previous checkout closed. Refresh billing before starting a new checkout." };
    }
    recoverable(row.attempt_at);
    const session = await provider.checkout(customer, z.string().parse(row.checkout_attempt));
    await db.query("UPDATE subscription_billing.workspace SET checkout_id=$1 WHERE workspace=$2", [
      session.id,
      workspace,
    ]);
    return Redirect.parse({ url: session.url });
  });
  if ("error" in result) throw new HttpError(409, result.error);
  return Response.json(result);
}
