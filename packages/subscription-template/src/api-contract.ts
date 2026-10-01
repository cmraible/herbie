import { z } from "zod";
import {
  Account,
  Workspace,
  WorkspaceList,
  CreateWorkspace,
  Configuration,
  Members,
  Invite,
  MembershipChange,
  Confirmation,
  Billing,
  Redirect,
} from "./contracts";
type Endpoint = {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  summary: string;
  input?: z.ZodType;
  output: z.ZodType;
  status?: number;
  public?: boolean;
};
export const endpoints: Endpoint[] = [
  { method: "get", path: "/health", summary: "Service health", output: Confirmation, public: true },
  {
    method: "get",
    path: "/api/config",
    summary: "Enabled integrations",
    output: Configuration,
    public: true,
  },
  { method: "get", path: "/api/account", summary: "Verified account", output: Account },
  {
    method: "get",
    path: "/api/workspaces",
    summary: "List current memberships",
    output: WorkspaceList,
  },
  {
    method: "post",
    path: "/api/workspaces",
    summary: "Create a workspace owned by the caller",
    input: CreateWorkspace,
    output: Workspace,
    status: 201,
  },
  {
    method: "get",
    path: "/api/workspaces/{workspace}",
    summary: "Read an accessible workspace",
    output: Workspace,
  },
  {
    method: "get",
    path: "/api/workspaces/{workspace}/members",
    summary: "List workspace members",
    output: Members,
  },
  {
    method: "post",
    path: "/api/workspaces/{workspace}/invitations",
    summary: "Invite or resend; administrator required",
    input: Invite,
    output: Confirmation,
    status: 201,
  },
  {
    method: "post",
    path: "/api/invitations/{invitation}/accept",
    summary: "Accept an invitation for the verified recipient",
    input: z.object({}).strict(),
    output: z.object({ workspace: z.string() }),
  },
  {
    method: "patch",
    path: "/api/workspaces/{workspace}/members/{member}",
    summary: "Change role; owner required",
    input: MembershipChange,
    output: Confirmation,
  },
  {
    method: "delete",
    path: "/api/workspaces/{workspace}/members/{member}",
    summary: "Remove a member; administrator required",
    output: Confirmation,
  },
  {
    method: "get",
    path: "/api/workspaces/{workspace}/billing",
    summary: "Read subscription entitlement",
    output: Billing,
  },
  {
    method: "post",
    path: "/api/workspaces/{workspace}/billing/checkout",
    summary: "Start or resume Checkout; administrator required",
    input: z.object({}).strict(),
    output: Redirect,
  },
  {
    method: "post",
    path: "/api/workspaces/{workspace}/billing/portal",
    summary: "Open customer portal; administrator required",
    input: z.object({}).strict(),
    output: Redirect,
  },
  {
    method: "post",
    path: "/api/workspaces/{workspace}/billing/refresh",
    summary: "Reconcile current Stripe state; administrator required",
    input: z.object({}).strict(),
    output: Billing,
  },
  {
    method: "post",
    path: "/api/billing/webhook",
    summary: "Stripe signed event; raw JSON with Stripe-Signature required",
    input: z.object({
      id: z.string(),
      type: z.string(),
      livemode: z.boolean(),
      data: z.object({ object: z.unknown() }),
    }),
    output: Confirmation,
    public: true,
  },
];
