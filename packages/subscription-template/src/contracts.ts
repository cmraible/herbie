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
