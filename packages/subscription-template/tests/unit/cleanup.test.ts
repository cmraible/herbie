import { afterEach, expect, test, vi } from "vitest";
import { cleanup } from "../../scripts/cleanup";
const parent = "abcdefghijklmnopqrst";
const name = "herbie-subscription-pr-12";
const branch = {
  project_ref: "previewbranchrefxxxxx",
  parent_project_ref: parent,
  name,
  is_default: false,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixture() {
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "pull_request_target",
    PR_NUMBER: "12",
    GITHUB_REPOSITORY: "example/template",
    GITHUB_TOKEN: "fixture-github-token",
    SUPABASE_PREVIEW_PROJECT_REF: parent,
    SUPABASE_PRODUCTION_PROJECT_REF: "productionrefxxxxxxx1",
    SUPABASE_ACCESS_TOKEN: "fixture-supabase-token",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "fixture-cloudflare-token",
    PREVIEW_ENABLED: "false",
  }))
    vi.stubEnv(key, value);
  const state = { closed: true, branches: [branch], worker: true, failDatabaseDelete: true };
  const deletions: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "api.github.com") {
      expect(url.pathname).toBe("/repos/example/template/pulls/12");
      return Response.json({
        state: state.closed ? "closed" : "open",
        head: { repo: { full_name: "example/template" } },
      });
    }
    if (request.method === "DELETE") deletions.push(url.hostname + url.pathname);
    if (url.hostname === "api.cloudflare.com") {
      expect(request.method).toBe("DELETE");
      expect(url.pathname).toBe(`/client/v4/accounts/${"a".repeat(32)}/workers/scripts/${name}`);
      const status = state.worker ? 200 : 404;
      state.worker = false;
      return new Response("", { status });
    }
    expect(url.hostname).toBe("api.supabase.com");
    if (request.method === "GET") {
      expect(url.pathname).toBe(`/v1/projects/${parent}/branches`);
      return Response.json(state.branches);
    }
    expect(request.method).toBe("DELETE");
    expect(url.pathname).toBe(`/v1/branches/${branch.project_ref}`);
    if (state.failDatabaseDelete) {
      state.failDatabaseDelete = false;
      return new Response("private", { status: 500 });
    }
    state.branches = [];
    return new Response(null, { status: 204 });
  });
  return { state, deletions };
}
test("cleanup retries a partial failure, tolerates absent resources and runs when preview creation is disabled", async () => {
  const { state, deletions } = fixture();
  await expect(cleanup()).rejects.toThrow("Supabase management operation failed (500)");
  expect(state.worker).toBe(false);
  expect(state.branches).toHaveLength(1);
  await cleanup();
  expect(state.branches).toHaveLength(0);
  await cleanup();
  expect(deletions.filter((path) => path.startsWith("api.supabase.com"))).toHaveLength(2);
  expect(deletions.filter((path) => path.startsWith("api.cloudflare.com"))).toHaveLength(3);
});
test("cleanup skips reopened reviews without deleting either provider's resource", async () => {
  const { state, deletions } = fixture();
  state.closed = false;
  await cleanup();
  expect(deletions).toEqual([]);
});
test("cleanup rejects default or unrelated branches before any deletion", async () => {
  for (const invalid of [
    { ...branch, is_default: true },
    { ...branch, parent_project_ref: "other-parent" },
  ]) {
    const { state, deletions } = fixture();
    state.branches = [invalid];
    await expect(cleanup()).rejects.toThrow("Refusing default or unrelated branch");
    expect(deletions).toEqual([]);
  }
});
