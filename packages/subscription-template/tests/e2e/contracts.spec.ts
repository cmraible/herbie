import { test, expect } from "@playwright/test";
import { register, createWorkspace } from "./helpers";
import { WorkspaceList } from "../../src/contracts";
test("public endpoints and team resources reject undocumented methods and path aliases", async ({
  page,
}) => {
  const headers = { origin: "http://localhost:8790" };
  for (const path of ["/health", "/ready", "/api/config"]) {
    expect((await page.request.get(path)).status()).toBe(200);
    expect((await page.request.post(path, { headers, data: {} })).status()).toBe(405);
  }
  await register(page, "Contract owner");
  await createWorkspace(page, "Contract team");
  const workspace = WorkspaceList.parse(
    await (await page.request.get("/api/workspaces")).json(),
  )[0];
  if (!workspace) throw new Error("Missing workspace");
  expect(
    (await page.request.get(`/api/workspaces/${workspace.id}/members/not-a-list`)).status(),
  ).toBe(405);
  expect(
    (
      await page.request.post(`/api/workspaces/${workspace.id}/invitations/not-a-create`, {
        headers,
        data: { email: "unused@example.test", role: "member" },
      })
    ).status(),
  ).toBe(405);
});
