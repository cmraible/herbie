import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { sendEmail } from "./auth";
import type { Env } from "./env";
import { Workspace, Members, Invite, MembershipChange, Confirmation } from "./contracts";
import { HttpError, body } from "./http";
const Role = z.enum(["owner", "admin", "member"]);
type Actor = { id: string; email: string };
export async function membership(db: Pick<Pool, "query">, user: string, workspace: string) {
  const result = await db.query<{ role: string }>(
    'SELECT role FROM subscription_auth.member WHERE "organizationId"=$1 AND "userId"=$2',
    [workspace, user],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(403, "Workspace access denied");
  return Role.parse(row.role);
}
export function requireAdmin(role: z.infer<typeof Role>) {
  if (role === "member") throw new HttpError(403, "Workspace administrator required");
}
export async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function teamRoute(
  req: Request,
  pool: Pool,
  env: Env,
  actor: Actor,
): Promise<Response | undefined> {
  const path = new URL(req.url).pathname;
  const accept = /^\/api\/invitations\/([^/]+)\/accept$/.exec(path);
  if (accept && req.method === "POST") {
    await body(req, z.object({}).strict());
    const id = z.string().parse(accept[1]);
    // Serialize acceptance with membership changes; the transaction also fences replay.
    const response = await transaction(pool, async (db) => {
      const lookup = await db.query<{ organizationId: string }>(
        'SELECT "organizationId" FROM subscription_auth.invitation WHERE id=$1',
        [id],
      );
      const organizationId = lookup.rows[0]?.organizationId;
      if (!organizationId) throw new HttpError(403, "Invitation unavailable");
      await db.query("SELECT id FROM subscription_auth.organization WHERE id=$1 FOR UPDATE", [
        organizationId,
      ]);
      const invitation = await db.query<{
        organizationId: string;
        email: string;
        status: string;
        expiresAt: Date;
        role: string;
        inviterId: string;
      }>(
        'SELECT "organizationId",email,status,"expiresAt",role,"inviterId" FROM subscription_auth.invitation WHERE id=$1 FOR UPDATE',
        [id],
      );
      const invite = invitation.rows[0];
      if (!invite || invite.email.toLowerCase() !== actor.email.toLowerCase())
        throw new HttpError(403, "Invitation unavailable");
      if (invite.status !== "pending" || invite.expiresAt.getTime() <= Date.now())
        throw new HttpError(409, "Invitation expired or already used");
      const inviterRole = await membership(db, invite.inviterId, invite.organizationId);
      requireAdmin(inviterRole);
      const role = z.enum(["admin", "member"]).parse(invite.role);
      if (role === "admin" && inviterRole !== "owner")
        throw new HttpError(403, "Invitation authority has changed");
      await db.query(
        'INSERT INTO subscription_auth.member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,$4,now()) ON CONFLICT("organizationId","userId") DO NOTHING',
        [crypto.randomUUID(), invite.organizationId, actor.id, role],
      );
      await db.query("UPDATE subscription_auth.invitation SET status='accepted' WHERE id=$1", [id]);
      return { workspace: invite.organizationId };
    });
    return Response.json(response);
  }
  const match = /^\/api\/workspaces\/([^/]+)(?:\/(members|invitations)(?:\/([^/]+))?)?$/.exec(path);
  if (!match) return;
  const workspace = z.string().parse(match[1]),
    resource = match[2],
    target = match[3];
  const role = await membership(pool, actor.id, workspace);
  if (!resource && req.method === "GET") {
    const result = await pool.query<{ id: string; name: string }>(
      "SELECT id,name FROM subscription_auth.organization WHERE id=$1",
      [workspace],
    );
    return Response.json(Workspace.parse({ ...result.rows[0], role }));
  }
  if (resource === "members" && !target && req.method === "GET") {
    const result = await pool.query<{
      id: string;
      userId: string;
      name: string;
      email: string;
      role: string;
    }>(
      'SELECT m.id,m."userId",u.name,u.email,m.role FROM subscription_auth.member m JOIN subscription_auth."user" u ON u.id=m."userId" WHERE m."organizationId"=$1 ORDER BY m."createdAt",m.id',
      [workspace],
    );
    return Response.json(Members.parse(result.rows));
  }
  if (resource === "invitations" && !target && req.method === "POST") {
    requireAdmin(role);
    const input = await body(req, Invite);
    if (input.role === "admin" && role !== "owner")
      throw new HttpError(403, "Only the owner can invite administrators");
    const id = await transaction(pool, async (db) => {
      await db.query("SELECT id FROM subscription_auth.organization WHERE id=$1 FOR UPDATE", [
        workspace,
      ]);
      const authority = await membership(db, actor.id, workspace);
      requireAdmin(authority);
      if (input.role === "admin" && authority !== "owner")
        throw new HttpError(403, "Only the owner can invite administrators");
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM subscription_auth.invitation WHERE "organizationId"=$1 AND lower(email)=$2 AND status='pending'`,
        [workspace, input.email],
      );
      const id = existing.rows[0]?.id ?? crypto.randomUUID();
      await db.query(
        `INSERT INTO subscription_auth.invitation(id,"organizationId",email,role,status,"expiresAt","inviterId","createdAt") VALUES($1,$2,$3,$4,'pending',now()+interval '7 days',$5,now()) ON CONFLICT(id) DO UPDATE SET role=excluded.role,"inviterId"=excluded."inviterId","expiresAt"=excluded."expiresAt"`,
        [id, workspace, input.email, input.role, actor.id],
      );
      return id;
    });
    await sendEmail(
      env,
      input.email,
      "Workspace invitation",
      env.APP_ORIGIN + "/?invitation=" + encodeURIComponent(id),
    );
    return Response.json(Confirmation.parse({ ok: true }), { status: 201 });
  }
  if (resource === "members" && target && ["PATCH", "DELETE"].includes(req.method)) {
    const change = req.method === "PATCH" ? await body(req, MembershipChange) : undefined;
    await transaction(pool, async (db) => {
      await db.query("SELECT id FROM subscription_auth.organization WHERE id=$1 FOR UPDATE", [
        workspace,
      ]);
      const currentRole = await membership(db, actor.id, workspace);
      requireAdmin(currentRole);
      const member = await db.query<{ role: string }>(
        'SELECT role FROM subscription_auth.member WHERE id=$1 AND "organizationId"=$2',
        [target, workspace],
      );
      const targetRole = member.rows[0]?.role;
      if (!targetRole) throw new HttpError(404, "Member not found");
      if (targetRole === "owner")
        throw new HttpError(409, "Workspace owner cannot be removed or demoted");
      if (currentRole !== "owner" && (targetRole !== "member" || change))
        throw new HttpError(403, "Only the owner can change administrator access");
      if (change)
        await db.query(
          'UPDATE subscription_auth.member SET role=$1 WHERE id=$2 AND "organizationId"=$3',
          [change.role, target, workspace],
        );
      else {
        await db.query(
          `UPDATE subscription_auth.invitation SET status='canceled' WHERE "organizationId"=$1 AND status='pending' AND lower(email)=(SELECT lower(u.email) FROM subscription_auth."user" u JOIN subscription_auth.member m ON m."userId"=u.id WHERE m.id=$2 AND m."organizationId"=$1)`,
          [workspace, target],
        );
        await db.query('DELETE FROM subscription_auth.member WHERE id=$1 AND "organizationId"=$2', [
          target,
          workspace,
        ]);
      }
    });
    return Response.json(Confirmation.parse({ ok: true }));
  }
  throw new HttpError(405, "Method not allowed");
}
