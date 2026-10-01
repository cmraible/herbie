import { z } from "zod";
export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["owner", "admin", "member"]),
});
export const WorkspaceList = z.array(Workspace);
export const CreateWorkspace = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const Account = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  twoFactorEnabled: z.boolean(),
});
export const Configuration = z.object({
  providers: z.array(z.enum(["google", "github", "chatgpt"])),
  billingEnabled: z.boolean(),
});
export const ErrorBody = z.object({ error: z.string() });
export const Member = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.email(),
  role: z.enum(["owner", "admin", "member"]),
});
export const Members = z.array(Member);
export const Invite = z
  .object({
    email: z.email().transform((e) => e.toLowerCase()),
    role: z.enum(["admin", "member"]).default("member"),
  })
  .strict();
export const MembershipChange = z.object({ role: z.enum(["admin", "member"]) }).strict();
export const Confirmation = z.object({ ok: z.literal(true) });
export const Billing = z.object({
  enabled: z.boolean(),
  status: z.enum([
    "none",
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
  ]),
  entitled: z.boolean(),
});
export const Redirect = z.object({ url: z.url() });
