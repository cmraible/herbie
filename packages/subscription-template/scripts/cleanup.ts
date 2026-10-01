import { z } from "zod";
import { pathToFileURL } from "node:url";
import { management, findBranch, target, canCleanup } from "./hosting";
export async function cleanup() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "pull_request_target"
  )
    throw new Error("Cleanup requires trusted PR-close workflow");
  const pr = z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/)
      .parse(process.env.PR_NUMBER),
    name = target(pr);
  const repository = z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .parse(process.env.GITHUB_REPOSITORY);
  const githubToken = z.string().min(1).parse(process.env.GITHUB_TOKEN);
  if (
    !(await canCleanup(
      async (path) => {
        const response = await fetch("https://api.github.com" + path, {
          headers: {
            Authorization: "Bearer " + githubToken,
            Accept: "application/vnd.github+json",
          },
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error("Cannot verify cleanup target");
        return response.json();
      },
      repository,
      pr,
    ))
  ) {
    console.log("Skipped cleanup: PR is no longer closed");
    return;
  }
  const parent = z
    .string()
    .regex(/^[a-z0-9]{20}$/)
    .parse(process.env.SUPABASE_PREVIEW_PROJECT_REF);
  if (
    !process.env.SUPABASE_PRODUCTION_PROJECT_REF ||
    parent === process.env.SUPABASE_PRODUCTION_PROJECT_REF
  )
    throw new Error("Review project must be isolated");
  const token = z.string().min(1).parse(process.env.SUPABASE_ACCESS_TOKEN),
    api = management(token);
  const branch = await findBranch(api, parent, name);
  const account = z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(process.env.CLOUDFLARE_ACCOUNT_ID);
  const cfToken = z.string().min(1).parse(process.env.CLOUDFLARE_API_TOKEN);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}`,
    {
      method: "DELETE",
      headers: { Authorization: "Bearer " + cfToken },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok && response.status !== 404) throw new Error("Review Worker cleanup failed");
  if (branch) await api(`/v1/branches/${branch.project_ref}`, "DELETE");
  console.log("Removed review resources for PR " + pr);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void cleanup().catch(() => {
    console.error(
      "Review cleanup failed; rerun the trusted cleanup job. No production resource was targeted.",
    );
    process.exitCode = 1;
  });
