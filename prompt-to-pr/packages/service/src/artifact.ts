import { z } from "zod";

export const MAX_PATCH_BYTES = 8 * 1024 * 1024;
export const agentResult = z
  .object({
    outcome: z.enum(["changes", "no_changes"]),
    title: z
      .string()
      .trim()
      .max(256)
      .refine((value) => !/[\r\n]/.test(value)),
    summary: z.string().trim().min(1).max(60_000),
    verification: z.string().trim().min(1).max(10_000),
  })
  .strict();
export const artifactSchema = z
  .object({
    repositoryId: z.number().int().positive().safe(),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/),
    patch: z
      .string()
      .max(MAX_PATCH_BYTES)
      .refine((value) => Buffer.byteLength(value) <= MAX_PATCH_BYTES),
    result: agentResult,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.result.outcome === "changes" && (!value.patch.trim() || !value.result.title))
      ctx.addIssue({ code: "custom", message: "Changes require a patch and PR title" });
    if (value.result.outcome === "no_changes" && value.patch.trim())
      ctx.addIssue({ code: "custom", message: "No-change result must not contain changes" });
  });
export type Artifact = z.infer<typeof artifactSchema>;

export class AttentionRequired extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
