import { z } from "zod";
export function productionDatabase(connection: string, project: string) {
  z.string()
    .regex(/^[a-z0-9]{20}$/)
    .parse(project);
  const url = new URL(connection);
  const direct = url.hostname === `db.${project}.supabase.co`;
  const pooled =
    /^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(url.hostname) &&
    decodeURIComponent(url.username).endsWith("." + project);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    (!direct && !pooled) ||
    !url.username ||
    !url.password ||
    url.pathname !== "/postgres" ||
    !["", "5432", "6543"].includes(url.port) ||
    url.hash ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
    url.searchParams.getAll("sslmode").length !== 1
  )
    throw new Error("Production database must use verified TLS to the approved Supabase project");
  return connection;
}
export function target(pr: string | undefined) {
  if (pr === undefined) return "herbie-subscription-template";
  return (
    "herbie-subscription-pr-" +
    z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/)
      .parse(pr)
  );
}
export function management(token: string) {
  return async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    const response = await fetch("https://api.supabase.com" + path, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error("Supabase management operation failed (" + response.status + ")");
    return response.status === 204 ? null : response.json();
  };
}
const Branch = z.object({
  project_ref: z.string(),
  parent_project_ref: z.string(),
  name: z.string(),
  is_default: z.boolean(),
});
export async function findBranch(api: ReturnType<typeof management>, parent: string, name: string) {
  const branches = z.array(Branch).parse(await api(`/v1/projects/${parent}/branches`));
  const matches = branches.filter((b) => b.name === name);
  if (matches.length > 1) throw new Error("Ambiguous review branch");
  const branch = matches[0];
  if (
    branch &&
    (branch.is_default || branch.project_ref === parent || branch.parent_project_ref !== parent)
  )
    throw new Error("Refusing default or unrelated branch");
  return branch;
}
export async function reviewDatabase(
  api: ReturnType<typeof management>,
  parent: string,
  name: string,
) {
  let branch = await findBranch(api, parent, name);
  if (!branch)
    branch = Branch.parse(
      await api(`/v1/projects/${parent}/branches`, "POST", {
        branch_name: name,
        persistent: false,
        with_data: false,
      }),
    );
  if (
    branch.name !== name ||
    branch.is_default ||
    branch.parent_project_ref !== parent ||
    branch.project_ref === parent
  )
    throw new Error("Invalid review branch response");
  const Details = z.object({
    ref: z.string(),
    status: z.string(),
    db_host: z.string(),
    db_port: z.number().int().positive(),
    db_user: z.string().optional(),
    db_pass: z.string().optional(),
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    const details = Details.parse(await api(`/v1/branches/${branch.project_ref}`));
    if (details.ref !== branch.project_ref) throw new Error("Review database mismatch");
    if (details.status === "ACTIVE_HEALTHY" && details.db_user && details.db_pass) {
      const url = new URL("postgresql://" + details.db_host + ":" + details.db_port + "/postgres");
      url.username = details.db_user;
      url.password = details.db_pass;
      url.searchParams.set("sslmode", "verify-full");
      return url.toString();
    }
    if (["INIT_FAILED", "REMOVED"].includes(details.status))
      throw new Error("Review database provisioning failed");
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error("Review database not ready; retry later using the same branch");
}
export async function assertCurrentTarget(
  read: (path: string) => Promise<unknown>,
  repository: string,
  sha: string,
  pr?: string,
) {
  if (pr) {
    const current = z
      .object({
        state: z.string(),
        head: z.object({ sha: z.string(), repo: z.object({ full_name: z.string() }) }),
        author_association: z.string(),
      })
      .parse(await read(`/repos/${repository}/pulls/${pr}`));
    if (
      current.state !== "open" ||
      current.head.sha !== sha ||
      current.head.repo.full_name !== repository ||
      !["OWNER", "MEMBER", "COLLABORATOR"].includes(current.author_association)
    )
      throw new Error("Review target is no longer eligible");
  } else {
    const branch = z
      .object({ commit: z.object({ sha: z.string() }) })
      .parse(await read(`/repos/${repository}/branches/main`));
    if (branch.commit.sha !== sha) throw new Error("Production target is superseded");
  }
}
export async function canCleanup(
  read: (path: string) => Promise<unknown>,
  repository: string,
  pr: string,
) {
  const current = z
    .object({ state: z.string(), head: z.object({ repo: z.object({ full_name: z.string() }) }) })
    .parse(await read(`/repos/${repository}/pulls/${pr}`));
  return current.state === "closed" && current.head.repo.full_name === repository;
}
